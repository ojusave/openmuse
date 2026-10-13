// This script runs on your computer. It asks Render to perform real work, then checks
// both the saved file contents and Render's final resource status independently.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Render } from "@renderinc/sdk";
import { RenderComputerService } from "../apps/server/src/computer-render.ts";
import { createStore } from "../apps/server/src/db.ts";
import { config } from "../tests/helpers/computer.ts";

// The script runs from the repository root with a locally saved Render key.
// These handles access paid sandboxes and a disposable local database.
const api = new Render().experimental.sandboxes;
const db = await createStore();
const s = new RenderComputerService(db, { ...config, computerProvider: "render" }, api);
const results: unknown[] = [];
// After each operation, read Render's resource status directly. A command
// receipt alone is not proof that the paid sandbox was terminated.
async function checked(name: string, action: () => Promise<unknown>) {
  const value = await action();
  const lease = await db.get<{ sandboxId: string; busy: boolean }>(
    "live-render",
    "computer-render-state",
    "lease",
  );
  if (lease?.sandboxId) {
    assert.equal((await api.get(lease.sandboxId)).status, "terminated");
    assert.equal(lease.busy, false);
  }
  results.push({ name, value, sandboxId: lease?.sandboxId, cleanup: "terminated" });
  console.log(JSON.stringify({ name, cleanup: "terminated" }));
  return value;
}
try {
  await checked("start", () => s.start("live-render"));
  await checked("write file", () => s.write("live-render", "/workspace/input.txt", "24,18,42"));
  // This known input has three numbers. The Python command excludes 18,
  // writes its answer in /workspace, and prints the expected total 66.
  const r = await s.execute(
    "live-render",
    {
      command:
        "python3 - <<'PY'\nimport json,os\nassert not any(os.environ.get(k) for k in ['RENDER_API_KEY','OPENAI_API_KEY','OPENROUTER_API_KEY','APP_ACCESS_TOKEN'])\na=[int(x) for x in open('input.txt').read().split(',')]\nr={'total':sum(x for x in a if x!=18)}\nopen('result.txt','w').write(json.dumps(r))\nprint(json.dumps(r))\nPY",
    },
    { idempotencyKey: "calculation" },
  );
  assert.equal(r.status, "succeeded");
  assert.equal(JSON.parse(r.stdout).total, 66);
  await checked("calculation", async () => r);
  // A repeated operation ID must return the original receipt, not rerun it.
  assert.deepEqual(
    await s.execute("live-render", { command: "not executed" }, { idempotencyKey: "calculation" }),
    r,
  );
  await s.stop("live-render");
  // A new service object imitates an API restart and must restore the same
  // saved output from the database into another sandbox.
  const restarted = new RenderComputerService(db, { ...config, computerProvider: "render" }, api);
  await checked("new provider after stop", () => restarted.start("live-render"));
  const file = await restarted.read("live-render", "/workspace/result.txt");
  assert.equal(JSON.parse(file.text).total, 66);
  await checked("restored exact file", async () => file);
  // A nonzero exit, a timeout, and an unsafe link each have distinct
  // receipts; the last known good workspace remains readable afterward.
  const bad = await restarted.execute("live-render", { command: "printf partial; exit 7" });
  assert.equal(bad.status, "failed");
  assert.equal(bad.exitCode, 7);
  await checked("nonzero exit", async () => bad);
  const timeout = await restarted.execute("live-render", { command: "sleep 35" });
  assert.equal(timeout.status, "timed_out");
  assert.equal(timeout.exitCode, 124);
  await checked("timeout", async () => timeout);
  const link = await restarted.execute("live-render", { command: "ln -s /etc /workspace/escape" });
  assert.equal(link.status, "failed");
  assert.match(link.stderr, /Symlinks/);
  await checked("symlink rejected", async () => link);
  assert.equal(
    JSON.parse((await restarted.read("live-render", "/workspace/result.txt")).text).total,
    66,
  );
  await checked("failed save retained previous workspace", async () => ({ total: 66 }));
  // A different authenticated owner starts empty and cannot read the first
  // owner's result, even though both use the same Render workspace.
  await restarted.start("other-owner");
  await assert.rejects(() => restarted.read("other-owner", "/workspace/result.txt"));
  const other = await db.get<{ sandboxId: string }>(
    "other-owner",
    "computer-render-state",
    "lease",
  );
  await restarted.stop("other-owner");
  assert.ok(other);
  assert.equal((await api.get(other.sandboxId)).status, "terminated");
  results.push({ name: "owner isolation", passed: true, cleanup: "terminated" });
  await s.stop("live-render");
} finally {
  // Always attempt logical Stop and save sanitized evidence, even if an
  // assertion fails. The provider itself handles physical sandbox cleanup.
  await s.stop("live-render").catch(() => {});
  await db.close();
  await mkdir("validation-render", { recursive: true });
  await writeFile(
    "validation-render/live.json",
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
  );
}
