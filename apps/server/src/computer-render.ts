// This server-side provider turns one authenticated OpenMuse request into one
// short-lived Render Sandbox operation. Imports provide IDs, file reading,
// path handling, Render access, and checked input/output shapes.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Render } from "@renderinc/sdk";
import { z } from "zod";
import type {
  ComputerCommand,
  ComputerDirectory,
  ComputerSnapshot,
} from "../../../packages/domain/src/computer.ts";
import { computerCommandSchema, workspacePath } from "./computer.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

// These names and limits apply only to data stored by OpenMuse. A transfer may
// be larger than the raw workspace because JSON and base64 encode file bytes.
const KIND = "computer-render-state";
const MAX_TRANSFER = 15 * 1024 * 1024;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Saved files travel as a list of relative paths and encoded bytes, called a manifest.
// Reject paths such as ../secret and cap the whole saved workspace before restoring it.
// Each saved item must be a relative name inside /workspace. The schema runs
// on the API server before restore and after export, even if sandbox code lies.
const entry = z.object({
  path: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (p) =>
        !p.startsWith("/") &&
        !p.includes("\0") &&
        p.split("/").every((s) => s && s !== "." && s !== ".."),
    ),
  type: z.enum(["file", "directory"]),
  data: z.string().optional(),
  executable: z.boolean().optional(),
});
// A manifest is the complete saved workspace. The loop rejects duplicate
// names and counts decoded file bytes, so a command cannot silently exceed
// the database-backed workspace limit.
const manifest = z
  .array(entry)
  .max(1000)
  .superRefine((entries, ctx) => {
    let bytes = 0;
    const paths = new Set<string>();
    for (const e of entries) {
      if (paths.has(e.path)) ctx.addIssue({ code: "custom", message: "Duplicate workspace path" });
      paths.add(e.path);
      if (e.type === "file") {
        if (
          !e.data ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.data)
        ) {
          if (e.data !== "") ctx.addIssue({ code: "custom", message: "Invalid workspace file" });
        }
        bytes += Buffer.byteLength(e.data ?? "", "base64");
      }
    }
    if (bytes > 10 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Workspace exceeds 10 MB" });
  });
// A command receipt is the small, checked answer shown to the user. The
// fixed helper writes it in Render; this server parses it before saving.
const commandResult = z.object({
  stdout: z.string().max(128 * 1024),
  stderr: z.string().max(128 * 1024),
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
});
// These records live under an authenticated owner in OpenMuse's database.
// Workspace holds wanted files; Lease blocks overlapping work or uncertain
// cleanup. Neither record is sent to the model as a credential.
type Workspace = {
  id: string;
  open: boolean;
  entries: z.infer<typeof manifest>;
  updatedAt?: string;
};
type Lease = {
  id: string;
  token: string;
  busy: boolean;
  sandboxId: string | null;
  stopping: boolean;
  expiresAt: number;
  error?: string;
};
export type RenderSandboxApi = Render["experimental"]["sandboxes"];
type Api = RenderSandboxApi;
// Stop waiting when Render does not respond. A timeout means the outcome is unknown,
// so the caller must check cleanup instead of automatically repeating the work.
export async function renderDeadline<T>(p: Promise<T>, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new AppError("Render operation timed out; do not replay uncertain work", 503)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// This class runs on the OpenMuse server. It keeps saved files in OpenMuse's database
// and sends only code and workspace contents to temporary Render computers.
export class RenderComputerService {
  constructor(
    readonly db: Store,
    readonly config: Config,
    private readonly suppliedApi?: Api,
    // The production wait is 30 seconds; tests can make a late response happen quickly.
    private readonly createTimeoutMs = 30000,
  ) {}
  // Tests inject a fake Render API. Production constructs the real SDK only
  // when this provider first needs it, using the server's Render key.
  private defaultApi?: Api;
  private get api(): Api {
    if (this.suppliedApi) return this.suppliedApi;
    this.defaultApi ??= new Render().experimental.sandboxes;
    return this.defaultApi;
  }
  // The feature gate prevents accidental sandbox spending by installations
  // that have not enabled the computer feature.
  private enabled() {
    if (!this.config.computerEnabled)
      throw new AppError("Enable COMPUTER_ENABLED to use the Render computer", 503);
  }
  // Read only this owner's saved files. A new owner starts with an empty,
  // stopped workspace rather than another person's files.
  private async workspace(owner: string) {
    return (
      (await this.db.get<Workspace>(owner, KIND, "workspace")) ?? {
        id: "workspace",
        open: false,
        entries: [],
      }
    );
  }
  // A database record gives one request permission to edit this owner's workspace.
  // This temporary ownership is called a lease. Its unique token stops an older
  // request from releasing a newer request's lock.
  private async acquire(owner: string) {
    this.enabled();
    const previous = await this.db.get<Lease>(owner, KIND, "lease");
    // A crashed server cannot silently discard an uncertain resource or replay a command.
    if (previous?.busy)
      throw new AppError(
        "Computer is busy or cleanup is unconfirmed. Use Stop before another operation.",
        409,
      );
    const lease: Lease = {
      id: "lease",
      token: randomUUID(),
      busy: true,
      sandboxId: null,
      stopping: false,
      expiresAt: Date.now() + 240000,
    };
    // The database comparison makes the claim atomic across API processes.
    // If another request won, this one must not create another paid sandbox.
    const claimed = previous
      ? await this.db.compareAndSwap<Lease>(
          owner,
          KIND,
          "lease",
          { token: previous.token, busy: false },
          lease,
        )
      : await this.db.insertIfAbsent(owner, KIND, lease);
    if (!claimed) throw new AppError("Computer is busy", 409);
    return lease;
  }
  // Request deletion, then read Render's status. Sending the request alone does not
  // prove that the sandbox stopped, so no new work is allowed until this succeeds.
  private async terminate(id: string) {
    // A retry may find a sandbox that has already ended. That is a confirmed
    // cleanup, so there is no need to send another termination request.
    if ((await renderDeadline(this.api.get(id))).status === "terminated") return;
    try {
      await renderDeadline(this.api.terminate(id));
    } catch (error) {
      if ((await renderDeadline(this.api.get(id))).status !== "terminated") throw error;
    }
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if ((await renderDeadline(this.api.get(id))).status === "terminated") return;
      await sleep(500);
    }
    throw new AppError("Render sandbox termination is unconfirmed", 503);
  }
  private async download(id: string, path: string) {
    // The helper's answer is a JSON file in the sandbox. Reject oversized
    // transfers before decoding them in the application server's memory.
    const file = await renderDeadline(this.api.download(id, path), 20000);
    if (file.size > MAX_TRANSFER)
      throw new AppError("Computer transfer exceeds the 15 MB limit", 413);
    return JSON.parse(file.data.toString("utf8"));
  }
  // One operation restores the owner's files, runs a fixed helper in Render, saves
  // the resulting files, and deletes the temporary computer. Provider credentials
  // stay in this server process and are never included in the uploaded files.
  private async operation(owner: string, request: Record<string, unknown>, signal?: AbortSignal) {
    const lease = await this.acquire(owner);
    // These local flags track whether work completed and whether deletion was
    // confirmed. Unknown cleanup keeps the database lock rather than guessing.
    let id: string | undefined;
    let uncertain = false;
    let expired = false;
    let output: unknown;
    let failure: unknown;
    let lateCleaned = false;
    try {
      const workspace = await this.workspace(owner);
      if (!workspace.open && request.operation !== "start")
        throw new AppError("Start the computer first", 409);
      if (signal?.aborted)
        throw new AppError("Computer operation was interrupted before execution", 409);
      // A fresh computer avoids carrying hidden processes between commands.
      // The lifetime is a backstop if this application crashes before cleanup.
      const pending = this.api.create({
        plan: "standard",
        region: "oregon",
        timeoutSeconds: 180,
        networkPolicy: { default: "deny-all" },
      });
      // The SDK might answer after our deadline. This callback records and
      // deletes that late sandbox so a timed-out create cannot leak resources.
      void pending
        .then(async (sandbox) => {
          if (!expired) return;
          await this.db.compareAndSwap(
            owner,
            KIND,
            "lease",
            { token: lease.token },
            { sandboxId: sandbox.id },
          );
          await this.terminate(sandbox.id);
          lateCleaned = true;
          const current = await this.db.get<Lease>(owner, KIND, "lease");
          if (current?.token === lease.token && current.stopping)
            await this.db.put(owner, KIND, { ...(await this.workspace(owner)), open: false });
          await this.db.compareAndSwap(
            owner,
            KIND,
            "lease",
            { token: lease.token },
            { busy: false, error: "" },
          );
        })
        .catch(() => {});
      let sandbox: Awaited<typeof pending>;
      try {
        sandbox = await renderDeadline(pending, this.createTimeoutMs);
      } catch (error) {
        uncertain = true;
        expired = true;
        throw error;
      }
      id = sandbox.id;
      await this.db.compareAndSwap(owner, KIND, "lease", { token: lease.token }, { sandboxId: id });
      // Wait for the sandbox to run and read back its actual network policy.
      // A create request alone does not prove the deny-all setting was applied.
      const readyUntil = Date.now() + 60000;
      while (true) {
        const current = await renderDeadline(this.api.get(id));
        const policy = current.networkPolicy as { default?: string; type?: string };
        if (
          !policy ||
          ![policy.type, policy.default].some((v) => v === "deny-all") ||
          [policy.type, policy.default].some((v) => v !== undefined && v !== "deny-all")
        )
          throw new AppError("Render did not confirm deny-all networking", 503);
        if (current.status === "running") break;
        if (["errored", "terminated"].includes(current.status) || Date.now() > readyUntil)
          throw new AppError("Render sandbox did not become ready", 503);
        await sleep(500);
      }
      // Cancel SDK transfers if the user stops the operation or the overall
      // execution window expires. Files remain in the prior saved workspace.
      const abort = AbortSignal.any([AbortSignal.timeout(55000), ...(signal ? [signal] : [])]);
      const stream = await this.api.exec(id, "mkdir -p /tmp/openmuse-control", undefined, abort);
      let setupExit: number | undefined;
      for await (const event of stream) if (event.type === "exit") setupExit = event.exit_code;
      if (setupExit !== 0) throw new AppError("Computer setup failed", 503);
      // These helpers run inside Render. The request contains the user command,
      // but the application server never executes that command itself.
      const uploads: [string, string][] = [
        ["workspace-in.json", JSON.stringify(manifest.parse(workspace.entries))],
        ["request.json", JSON.stringify(request)],
        ["files.py", readFileSync("apps/computer/files.py", "utf8")],
        ["driver.py", readFileSync("apps/computer/render_operation.py", "utf8")],
      ];
      for (const [path, content] of uploads)
        await this.api.upload(id, `/tmp/openmuse-control/${path}`, content, undefined, {
          signal: abort,
        });
      const before = await this.db.get<Lease>(owner, KIND, "lease");
      if (before?.stopping) throw new AppError("Computer was stopped before execution", 409);
      let exit: number | undefined;
      for await (const event of await this.api.exec(
        id,
        "timeout --kill-after=2s 45s python3 -I /tmp/openmuse-control/driver.py",
        undefined,
        abort,
      ))
        if (event.type === "exit") exit = event.exit_code;
      if (exit !== 0)
        throw new AppError(
          "Computer execution was interrupted; the last saved workspace was retained",
          503,
        );
      // Download the helper's answer and the resulting workspace separately.
      // Save nothing unless both passed their server-side checks.
      const payload = await this.download(id, "/tmp/openmuse-control/result.json");
      if (payload.ok !== true)
        throw new AppError(
          `Workspace operation failed: ${String(payload.error).slice(0, 500)}`,
          422,
        );
      const saved = manifest.parse(
        await this.download(id, "/tmp/openmuse-control/workspace-out.json"),
      );
      const current = await this.db.get<Lease>(owner, KIND, "lease");
      if (current?.stopping || signal?.aborted)
        throw new AppError("Computer was interrupted; the last saved workspace was retained", 409);
      // Replace saved files only after the complete workspace passes validation.
      // A failed export leaves the previous saved workspace available.
      await this.db.put(owner, KIND, {
        id: "workspace",
        open: true,
        entries: saved,
        updatedAt: new Date().toISOString(),
      });
      output = payload.result;
    } catch (error) {
      // Return a plain failure to the caller; never reveal an SDK exception
      // that could contain request details or server-side credentials.
      failure =
        error instanceof AppError
          ? error
          : new AppError(
              "Render operation failed; inspect the last saved workspace before retrying",
              503,
            );
    } finally {
      // Every path, including a failed command or bad export, tries to stop the
      // paid sandbox and verifies Render reports it as terminated.
      if (id) {
        try {
          await this.terminate(id);
        } catch {
          uncertain = true;
        }
      }
      // A Stop request may arrive during execution. Close the logical
      // workspace, then release the lock only when cleanup was confirmed.
      const finishing = await this.db.get<Lease>(owner, KIND, "lease");
      if (finishing?.token === lease.token && finishing.stopping)
        await this.db.put(owner, KIND, { ...(await this.workspace(owner)), open: false });
      uncertain = uncertain && !lateCleaned;
      await this.db.compareAndSwap(
        owner,
        KIND,
        "lease",
        { token: lease.token },
        {
          busy: uncertain,
          error: uncertain
            ? id
              ? `Cleanup unconfirmed for ${id}. Use Stop to retry.`
              : "Sandbox creation outcome unknown; inspect Render before retrying."
            : "",
        },
      );
    }
    uncertain = uncertain && !lateCleaned;
    if (uncertain)
      throw new AppError(
        "Sandbox cleanup is unconfirmed; new operations are blocked. Use Stop to retry cleanup.",
        503,
      );
    if (failure) throw failure;
    return output;
  }

  // Build the status shown by both the app and the model. "Running" means the
  // workspace accepts operations; each physical Render computer is short-lived.
  async snapshot(owner: string): Promise<ComputerSnapshot> {
    const workspace = await this.workspace(owner);
    const lease = await this.db.get<Lease>(owner, KIND, "lease");
    // Show recent receipts for this owner only; an agent and the UI use this
    // same status to avoid reporting a result merely because the model said so.
    const commands = (await this.db.list<ComputerCommand>(owner, "computer-render-commands"))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100);
    return {
      enabled: Boolean(this.config.computerEnabled),
      provider: "render",
      status: !this.config.computerEnabled
        ? "unconfigured"
        : lease?.error
          ? "error"
          : workspace.open
            ? "running"
            : "stopped",
      workspacePath: "/workspace",
      network: "disabled",
      commands,
      message:
        lease?.error ||
        "Render restores saved files into a fresh sandbox for each operation. Completed workspace files survive stops; shell processes and files outside /workspace do not.",
    };
  }
  async start(owner: string) {
    await this.operation(owner, { operation: "start" });
    return this.snapshot(owner);
  }
  // Stop accepts no new work and interrupts an active sandbox when necessary.
  // Completed saved files remain in the database; unsaved interrupted writes may be lost.
  async stop(owner: string) {
    this.enabled();
    const lease = await this.db.get<Lease>(owner, KIND, "lease");
    // Idle Stop only changes the saved workspace's open flag. It still takes
    // the shared lock so another API process cannot start a command at once.
    if (!lease?.busy) {
      const lock = await this.acquire(owner);
      try {
        await this.db.put(owner, KIND, { ...(await this.workspace(owner)), open: false });
      } finally {
        await this.db.compareAndSwap(owner, KIND, "lease", { token: lock.token }, { busy: false });
      }
      return this.snapshot(owner);
    }
    // During active work, mark Stop first so execution will not commit its
    // files. Then terminate the known sandbox and wait for the worker to exit.
    if (lease?.busy) {
      await this.db.compareAndSwap(
        owner,
        KIND,
        "lease",
        { token: lease.token },
        { stopping: true },
      );
      if (lease.sandboxId) await this.terminate(lease.sandboxId);
      else if (Date.now() < lease.expiresAt)
        throw new AppError("Sandbox creation is still resolving. Try Stop again shortly.", 409);
      if (Date.now() < lease.expiresAt && !lease.error) {
        const end = Date.now() + 15000;
        while (Date.now() < end && (await this.db.get<Lease>(owner, KIND, "lease"))?.busy)
          await sleep(250);
        if ((await this.db.get<Lease>(owner, KIND, "lease"))?.busy)
          throw new AppError("Stop requested; cleanup is still finishing", 409);
      } else {
        if (!lease.sandboxId)
          throw new AppError(
            "Sandbox creation outcome is unknown. Inspect Render before clearing this lock.",
            503,
          );
        await this.db.put(owner, KIND, { ...(await this.workspace(owner)), open: false });
        await this.db.compareAndSwap(
          owner,
          KIND,
          "lease",
          { token: lease.token },
          { busy: false, error: "" },
        );
      }
    }
    return this.snapshot(owner);
  }
  // Save a command receipt so the same operation ID can return its existing answer.
  // This prevents a repeated network request from running the command twice.
  async execute(
    owner: string,
    input: unknown,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ComputerCommand> {
    const args = computerCommandSchema.parse(input);
    workspacePath(args.cwd);
    // An operation ID is hashed into a stable receipt ID. A repeated HTTP
    // request returns that receipt rather than running the command twice.
    const id = options.idempotencyKey
      ? createHash("sha256").update(options.idempotencyKey).digest("hex")
      : randomUUID();
    const existing = await this.db.get<ComputerCommand>(owner, "computer-render-commands", id);
    if (existing) return existing;
    const command: ComputerCommand = {
      id,
      command: args.command,
      cwd: args.cwd,
      status: "running",
      stdout: "",
      stderr: "",
      truncated: false,
      startedAt: new Date().toISOString(),
    };
    if (!(await this.db.insertIfAbsent(owner, "computer-render-commands", command))) {
      const duplicate = await this.db.get<ComputerCommand>(owner, "computer-render-commands", id);
      if (!duplicate) throw new AppError("Command receipt unavailable", 503);
      return duplicate;
    }
    try {
      // A nonzero exit is still a real result with saved workspace changes.
      // A transport or cleanup failure becomes a failed receipt for inspection.
      const result = commandResult.parse(
        await this.operation(owner, { operation: "command", ...args }, options.signal),
      );
      return await this.db.put(owner, "computer-render-commands", {
        ...command,
        ...result,
        status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "succeeded" : "failed",
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      // Stop can interrupt a command even when the HTTP request itself has
      // not aborted. Mark that receipt as interrupted so users know its
      // unsaved changes may be absent from the next workspace.
      const interrupted =
        options.signal?.aborted ||
        (error instanceof AppError && /interrupted|stopped before execution/i.test(error.message));
      return this.db.put(owner, "computer-render-commands", {
        ...command,
        status: interrupted ? "interrupted" : "failed",
        stderr: error instanceof AppError ? error.message : "Computer operation failed",
        completedAt: new Date().toISOString(),
      });
    }
  }
  // File tools reuse the same restore, save and cleanup path as commands.
  // The fixed Python helper rejects links and paths outside /workspace.
  private file<T>(
    owner: string,
    operation: string,
    path: string,
    extra: Record<string, unknown> = {},
  ) {
    // Path checking happens on the API server before a paid sandbox starts.
    // The fixed Python helper checks paths again inside Render.
    return this.operation(owner, { operation, path: workspacePath(path), ...extra }) as Promise<T>;
  }
  list(owner: string, path = "/workspace"): Promise<ComputerDirectory> {
    return this.file<ComputerDirectory>(owner, "list", path);
  }
  read(owner: string, path: string): Promise<{ path: string; text: string }> {
    return this.file<{ path: string; text: string }>(owner, "read", path);
  }
  write(owner: string, path: string, text: string): Promise<{ path: string }> {
    if (Buffer.byteLength(text) > 256 * 1024)
      throw new AppError("Text files must be 256 KB or smaller", 413);
    return this.file<{ path: string }>(owner, "write", path, { text });
  }
  mkdir(owner: string, path: string): Promise<{ path: string }> {
    return this.file<{ path: string }>(owner, "mkdir", path);
  }
  writePdf(owner: string, path: string, bytes: Uint8Array): Promise<{ path: string }> {
    // PDFs may enter from OpenMuse Documents. Check their signature and size
    // before uploading bytes into a new sandbox.
    if (bytes.length > 10 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
      throw new AppError("Choose a PDF of 10 MB or smaller", 422);
    return this.file<{ path: string }>(owner, "write_pdf", path, {
      base64: Buffer.from(bytes).toString("base64"),
    });
  }
  async pdfBytes(owner: string, path: string) {
    const r = await this.file<{ base64: string }>(owner, "read_pdf", path);
    return { name: posix.basename(path), bytes: Buffer.from(r.base64, "base64") };
  }
}
