import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";

import { localServiceRoleKey } from "../e2e/helpers/supabase";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it("uses the configured fixture key without running the CLI", () => {
  vi.stubEnv("LOCAL_SUPABASE_SERVICE_ROLE_KEY", "configured-test-key");

  expect(localServiceRoleKey()).toBe("configured-test-key");
  expect(execFileSync).not.toHaveBeenCalled();
});

it("captures CLI stdout and stderr while reading the fixture key", () => {
  vi.stubEnv("LOCAL_SUPABASE_SERVICE_ROLE_KEY", undefined);
  vi.mocked(execFileSync).mockReturnValue('{"SERVICE_ROLE_KEY":"cli-test-key"}');

  expect(localServiceRoleKey()).toBe("cli-test-key");
  expect(execFileSync).toHaveBeenCalledWith("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
});

it("fails visibly on CLI failure without exposing captured credentials", () => {
  vi.stubEnv("LOCAL_SUPABASE_SERVICE_ROLE_KEY", undefined);
  vi.mocked(execFileSync).mockImplementation(() => {
    throw Object.assign(new Error("Command failed: secret-test-key"), {
      stdout: '{"SERVICE_ROLE_KEY":"secret-test-key"}',
      stderr: "CLI failure: secret-test-key",
    });
  });

  expect(localServiceRoleKey).toThrow("Unable to run supabase status for E2E setup.");
  try {
    localServiceRoleKey();
  } catch (error) {
    expect(String(error)).not.toContain("secret-test-key");
    expect(error).not.toHaveProperty("cause");
  }
});

it.each(["not JSON", "{}", '{"SERVICE_ROLE_KEY":""}', '{"SERVICE_ROLE_KEY":42}'])(
  "fails visibly on malformed or incomplete status: %s",
  (status) => {
    vi.stubEnv("LOCAL_SUPABASE_SERVICE_ROLE_KEY", undefined);
    vi.mocked(execFileSync).mockReturnValue(status);

    expect(localServiceRoleKey).toThrow("Invalid local Supabase status for E2E setup.");
  },
);
