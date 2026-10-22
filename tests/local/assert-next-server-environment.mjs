import nextEnv from "@next/env";
import { assertTestEnvironment } from "./environment.mjs";

// Check the environment after the same .env load Next.js performs, in the
// process that will launch the Playwright Next.js server.
const mode = process.argv[2];
if (mode !== "production" && mode !== "development") {
  throw new Error("Expected a Next.js server mode.");
}
process.env.NODE_ENV = mode;
nextEnv.loadEnvConfig(process.cwd(), mode === "development");
assertTestEnvironment();
if (process.env.APP_URL !== "http://localhost:3100") {
  throw new Error("Playwright must use its isolated Next.js server on port 3100.");
}
console.log("Playwright Next.js environment: sandbox email, isolated test database on port 55322.");
