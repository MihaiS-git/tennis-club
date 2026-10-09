import { expect } from "vitest";
import { assertTestEnvironment } from "./environment.mjs";

if (expect.getState().testPath?.replaceAll("\\", "/").includes("/tests/integration/")) {
  assertTestEnvironment();
}
