// These tests run locally. A fake Render API lets us force cleanup and
// concurrency failures that would be unreliable to reproduce with paid sandboxes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { createComputer } from "../apps/server/src/computer-provider.ts";
import {
  RenderComputerService,
  type RenderSandboxApi,
} from "../apps/server/src/computer-render.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { config } from "./helpers/computer.ts";

// The local test database holds workspace and command receipts. It is closed
// after the suite, just as the API server closes storage on shutdown.
let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});
// This replacement Render API checks the paid plan and network policy without
// creating a real resource. Each test can force a different failure and inspect
// whether the provider attempted cleanup.
function fake(
  options: {
    exitCode?: number;
    badPolicy?: boolean;
    missingExit?: boolean;
    cleanupFails?: boolean;
    badManifest?: boolean;
  } = {},
) {
  let created = 0;
  // Track resource IDs and uploaded request files so fake downloads can return
  // the answer the fixed sandbox helper would have produced.
  const terminated = new Set<string>();
  const uploads = new Map<string, Map<string, string>>();
  const api = {
    create: async (input: {
      plan: string;
      timeoutSeconds: number;
      networkPolicy: { default: string };
    }) => {
      assert.equal(input.plan, "standard");
      assert.equal(input.timeoutSeconds, 180);
      assert.equal(input.networkPolicy.default, "deny-all");
      const id = `sbx-${++created}`;
      uploads.set(id, new Map());
      return { id };
    },
    get: async (id: string) => ({
      status: terminated.has(id) ? "terminated" : "running",
      networkPolicy: { default: options.badPolicy ? "allow-all" : "deny-all" },
    }),
    terminate: async (id: string) => {
      if (options.cleanupFails) throw Error("unconfirmed");
      terminated.add(id);
    },
    upload: async (id: string, path: string, data: string) => {
      uploads.get(id)?.set(path, data);
    },
    exec: async () =>
      (async function* () {
        if (!options.missingExit) yield { type: "exit", exit_code: 0 };
      })(),
    download: async (id: string, path: string) => {
      const request = JSON.parse(
        uploads.get(id)?.get("/tmp/openmuse-control/request.json") || "{}",
      );
      const saved = JSON.parse(
        uploads.get(id)?.get("/tmp/openmuse-control/workspace-in.json") || "[]",
      );
      // The provider downloads a workspace and an operation answer. Return
      // deliberately invalid data when a test checks rejection behavior.
      const value = path.endsWith("workspace-out.json")
        ? options.badManifest
          ? [{ path: "../escape", type: "directory" }]
          : saved
        : {
            ok: true,
            result:
              request.operation === "read"
                ? {
                    path: request.path,
                    text: Buffer.from(
                      saved.find((e: { path: string }) => `/workspace/${e.path}` === request.path)
                        ?.data || "",
                      "base64",
                    ).toString("utf8"),
                  }
                : request.operation === "command"
                  ? {
                      stdout: "66\n",
                      stderr: "",
                      exitCode: options.exitCode ?? 0,
                      timedOut: false,
                      truncated: false,
                    }
                  : { ready: true },
          };
      const data = Buffer.from(JSON.stringify(value));
      return { data, size: data.length };
    },
  } as unknown as RenderSandboxApi;
  return { api, terminated, count: () => created };
}
// A failed shell command is still a real receipt. The same operation ID must
// return it without paying for a second run; another owner sees no receipts.
test("Render provider persists receipts and idempotent commands never replay", async () => {
  const f = fake({ exitCode: 7 });
  const s = new RenderComputerService(db, config, f.api);
  await s.start("receipt");
  const r = await s.execute("receipt", { command: "exit 7" }, { idempotencyKey: "same" });
  assert.equal(r.status, "failed");
  assert.equal(r.exitCode, 7);
  assert.equal(r.stdout, "66\n");
  assert.deepEqual(
    await s.execute("receipt", { command: "exit 7" }, { idempotencyKey: "same" }),
    r,
  );
  assert.equal(f.count(), 2);
  assert.equal(f.terminated.size, 2);
  assert.equal((await s.snapshot("different-owner")).commands.length, 0);
});
test("disabled provider never creates resources", async () => {
  const f = fake();
  const s = new RenderComputerService(db, { ...config, computerEnabled: false }, f.api);
  assert.equal((await s.snapshot("disabled")).status, "unconfigured");
  await assert.rejects(() => s.start("disabled"));
  assert.equal(f.count(), 0);
});
// These controlled failures prove that policy, helper execution, and saved
// paths must pass checks before OpenMuse accepts any new workspace.
for (const [name, options] of Object.entries({
  policy: { badPolicy: true },
  missing_exit: { missingExit: true },
  manifest: { badManifest: true },
}))
  test(`${name} fails closed and terminates`, async () => {
    const f = fake(options);
    const s = new RenderComputerService(db, config, f.api);
    await assert.rejects(() => s.start(name));
    assert.equal(f.terminated.size, 1);
    assert.equal((await s.snapshot(name)).status, "stopped");
  });
// Two API processes share the database lock. When deletion is uncertain,
// neither may start new work until a confirmed Stop recovers the known ID.
test("cleanup failure blocks a second provider instance", async () => {
  const behavior = { cleanupFails: true };
  const f = fake(behavior);
  const a = new RenderComputerService(db, config, f.api);
  const b = new RenderComputerService(db, config, f.api);
  await assert.rejects(() => a.start("cleanup"), /cleanup is unconfirmed/);
  await assert.rejects(() => b.start("cleanup"), /busy|cleanup/);
  assert.equal(f.count(), 1);
  assert.equal((await a.snapshot("cleanup")).status, "error");
  // After Render recovers, Stop checks the same recorded ID and releases the lock.
  behavior.cleanupFails = false;
  assert.equal((await b.stop("cleanup")).status, "stopped");
  await a.start("cleanup");
  assert.equal(f.terminated.size, 2);
});
// Reject bad input on the API server before it can spend money on a sandbox.
// Stop can arrive after a command begins but before its saved files come back.
// The last completed workspace must stay intact and the command must say
// interrupted instead of claiming a completed write.
test("Stop during execution preserves the previous workspace", async () => {
  const f = fake();
  const owner = "stop-during-run";
  const s = new RenderComputerService(db, config, f.api);
  await s.start(owner);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const download = f.api.download.bind(f.api);
  let hold = true;
  const api = {
    ...f.api,
    download: async (id: string, path: string) => {
      if (hold && path.endsWith("result.json")) {
        hold = false;
        entered();
        await gate;
      }
      return download(id, path);
    },
  } as RenderSandboxApi;
  const active = new RenderComputerService(db, config, api);
  const running = active.execute(owner, { command: "printf new" });
  await waiting;
  const stopped = active.stop(owner);
  // Wait until Stop has set the shared flag before the fake sandbox answers.
  for (let attempt = 0; attempt < 100; attempt++) {
    const lease = await db.get<{ stopping: boolean }>(owner, "computer-render-state", "lease");
    if (lease?.stopping) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    (await db.get<{ stopping: boolean }>(owner, "computer-render-state", "lease"))?.stopping,
    true,
  );
  release();
  const receipt = await running;
  assert.equal(receipt.status, "interrupted");
  assert.equal((await stopped).status, "stopped");
  assert.equal(f.terminated.size, 2);
  assert.equal((await s.snapshot(owner)).status, "stopped");
});

test("path traversal and oversized files are rejected before resource creation", async () => {
  const f = fake();
  const s = new RenderComputerService(db, config, f.api);
  assert.throws(() => s.write("path", "/workspace/../etc/passwd", "x"));
  assert.throws(() => s.write("path", "/workspace/file", "x".repeat(256 * 1024 + 1)));
  assert.equal(f.count(), 0);
});
// Existing installations still use Docker unless COMPUTER_PROVIDER selects Render.
test("Render selection is explicit and Docker remains default", () => {
  assert.ok(
    createComputer(db, { ...config, computerProvider: "render" }) instanceof RenderComputerService,
  );
  assert.equal(createComputer(db, config) instanceof RenderComputerService, false);
});
test("stopping an idle workspace uses the shared database lock", async () => {
  const f = fake();
  const a = new RenderComputerService(db, config, f.api);
  const b = new RenderComputerService(db, config, f.api);
  await a.start("stop");
  assert.equal((await b.stop("stop")).status, "stopped");
  assert.equal((await a.snapshot("stop")).status, "stopped");
  assert.equal(f.count(), 1);
});

// Closing and reopening the database simulates the API process restarting. Saved
// bytes still have to reach the next sandbox before a read can return them.
test("saved workspace survives a database restart", async () => {
  await mkdir("validation-render", { recursive: true });
  const dataDir = await mkdtemp(join(resolve("validation-render"), "db-restart-"));
  const first = await createStore({ dataDir });
  await first.put("durable", "computer-render-state", {
    id: "workspace",
    open: true,
    entries: [{ path: "result.txt", type: "file", data: Buffer.from("66").toString("base64") }],
  });
  await first.close();
  const second = await createStore({ dataDir });
  try {
    const f = fake();
    const provider = new RenderComputerService(second, config, f.api);
    assert.equal((await provider.read("durable", "/workspace/result.txt")).text, "66");
    assert.equal(f.terminated.size, 1);
  } finally {
    await second.close();
  }
});

// A delayed SDK response must still be cleaned up after the request timed out.
test("a late create response is still terminated and unlocks the owner", async () => {
  const f = fake();
  let release: ((value: { id: string }) => void) | undefined;
  const pending = new Promise<{ id: string }>((resolve) => {
    release = resolve;
  });
  const api = { ...f.api, create: () => pending } as unknown as RenderSandboxApi;
  const provider = new RenderComputerService(db, config, api, 5);
  await assert.rejects(() => provider.start("late-create"), /cleanup is unconfirmed/);
  assert.equal((await provider.snapshot("late-create")).status, "error");
  release?.({ id: "sbx-late" });
  for (let i = 0; i < 20; i++) {
    if (
      f.terminated.has("sbx-late") &&
      (await db.get<{ busy: boolean }>("late-create", "computer-render-state", "lease"))?.busy ===
        false
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(f.terminated.has("sbx-late"), true);
  assert.equal((await provider.snapshot("late-create")).status, "stopped");
});
