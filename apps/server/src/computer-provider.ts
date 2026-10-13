import { ComputerService, type DockerRunner } from "./computer.ts";
import { RenderComputerService } from "./computer-render.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";

// A provider implements the operations shared by the API routes and model tools.
// Keeping one shape lets existing Docker installations continue unchanged.
export type ComputerProvider = Pick<
  ComputerService,
  | "snapshot"
  | "start"
  | "stop"
  | "execute"
  | "list"
  | "read"
  | "write"
  | "mkdir"
  | "writePdf"
  | "pdfBytes"
>;
// Keep the existing Docker behavior unless the owner explicitly selects Render.
// Both implementations answer the same command, file and start/stop requests.
export function createComputer(db: Store, config: Config, docker?: DockerRunner): ComputerProvider {
  return config.computerProvider === "render"
    ? new RenderComputerService(db, config)
    : new ComputerService(db, config, docker);
}
