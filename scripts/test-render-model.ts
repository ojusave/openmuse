// Use OpenMuse's real model adapter and normal computer tools. The test owns the
// original order data and checks the saved answer after the model has finished.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EventType } from "@ag-ui/core";
import { Render } from "@renderinc/sdk";
import { createAuth } from "../apps/server/src/auth.ts";
import { RenderComputerService } from "../apps/server/src/computer-render.ts";
import { computerInstructions, computerTools } from "../apps/server/src/computer-tools.ts";
import { createStore } from "../apps/server/src/db.ts";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { Files } from "../apps/server/src/files.ts";
import { config } from "../tests/helpers/computer.ts";

// The API normally reads OPENAI_API_KEY. This local acceptance test maps the
// saved OpenRouter key into that expected name without writing it to source.
if (!process.env.OPENROUTER_API_KEY) throw Error("OPENROUTER_API_KEY is required");
process.env.OPENAI_API_KEY = process.env.OPENROUTER_API_KEY;
process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
const db = await createStore();
const api = new Render().experimental.sandboxes;
const computer = new RenderComputerService(db, { ...config, computerProvider: "render" }, api);
const testConfig = { ...config, dataDir: resolve("validation-render/model-auth") };
const auth = await createAuth(db, testConfig);
const files = new Files(db, testConfig, auth);
const owner = "render-model-proof";
const controller = new AbortController();
// Synthetic orders make the expected answer independently checkable:
// 24 + 42 = 66, while the cancelled 18 must not contribute.
const original = JSON.stringify([
  { amount: 24, cancelled: false },
  { amount: 18, cancelled: true },
  { amount: 42, cancelled: false },
]);
try {
  await computer.start(owner);
  await computer.write(owner, "/workspace/orders.json", original);
  // Run OpenMuse's actual model and tool adapter. The model must read the
  // existing file, call the computer tool, save the answer, and check it.
  const agent = tanstackAgent({
    model: "openai/openai/gpt-4o-mini",
    maxSteps: 8,
    tools: computerTools(computer, files, owner, "model-proof", { signal: controller.signal }),
    prompt:
      computerInstructions +
      " Use run_computer_python for Python source code. Read the data file first. Do not overwrite input files. Finish after saving and checking the result. No other tasks are needed.",
  });
  // Count real tool calls and stop the test if the provider stalls. Model
  // text alone is not a success criterion; file bytes are checked below.
  let calls = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      agent.abortRun();
      reject(Error("Model test timed out"));
    }, 180000);
    agent
      .run({
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [
          {
            id: randomUUID(),
            role: "user",
            content:
              "Read the existing /workspace/orders.json first. Each object has numeric `amount` and boolean `cancelled` fields. Use run_computer_python with plain Python code to sum `amount` only where `cancelled` is false. Print JSON with key total and save that exact JSON to /workspace/total.json. Read the saved file to check the result, then stop the computer.",
          },
        ],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .subscribe({
        next: (event) => {
          if (event.type === EventType.TOOL_CALL_START) calls++;
          if (event.type === EventType.RUN_ERROR) {
            clearTimeout(timer);
            reject(Error("Model provider returned an error"));
          }
        },
        error: () => {
          clearTimeout(timer);
          reject(Error("Model transport failed"));
        },
        complete: () => {
          clearTimeout(timer);
          resolve();
        },
      });
  });
  // Inspect the saved command receipt, then reopen the workspace in a new
  // sandbox and read the actual output and unchanged input files.
  const snapshot = await computer.snapshot(owner);
  assert.ok(snapshot.commands.some((c) => c.status === "succeeded" && c.exitCode === 0));
  await computer.stop(owner);
  await computer.start(owner);
  const result = await computer.read(owner, "/workspace/total.json");
  assert.equal(JSON.parse(result.text).total, 66);
  assert.equal((await computer.read(owner, "/workspace/orders.json")).text, original);
  const lease = await db.get<{ sandboxId: string; busy: boolean }>(
    owner,
    "computer-render-state",
    "lease",
  );
  await computer.stop(owner);
  assert.ok(lease);
  assert.equal(lease.busy, false);
  assert.equal((await api.get(lease.sandboxId)).status, "terminated");
  await mkdir("validation-render", { recursive: true });
  // Save only synthetic inputs and receipts under an ignored local folder.
  // This evidence can be reviewed without disclosing provider credentials.
  await writeFile(
    "validation-render/model.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        model: "openai/gpt-4o-mini via OpenRouter",
        toolCalls: calls,
        total: 66,
        inputUnchanged: true,
        commands: snapshot.commands,
        cleanup: "terminated",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      modelToolsPassed: true,
      toolCalls: calls,
      total: 66,
      inputUnchanged: true,
      cleanup: "terminated",
    }),
  );
} catch (error) {
  // Keep a local diagnostic when the model computes the wrong answer. It contains
  // only the synthetic fixture and command receipts, never provider credentials.
  await mkdir("validation-render", { recursive: true });
  const state = await computer.snapshot(owner);
  const total = await computer.read(owner, "/workspace/total.json").catch(() => null);
  await writeFile(
    "validation-render/model-diagnostic.json",
    JSON.stringify(
      {
        commands: state.commands,
        savedResult: total?.text,
        error: error instanceof Error ? error.message : "unknown",
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  // End any remaining model work, close the logical workspace, and release
  // the local database even if an assertion or provider request failed.
  controller.abort();
  await computer.stop(owner).catch(() => {});
  await db.close();
}
