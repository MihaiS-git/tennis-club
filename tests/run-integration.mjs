import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configureTestEnvironment } from "./local/environment.mjs";

configureTestEnvironment();

const child = spawn(process.execPath, [
  fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run", "--dir", "tests/integration", "--no-file-parallelism", ...process.argv.slice(2),
], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
