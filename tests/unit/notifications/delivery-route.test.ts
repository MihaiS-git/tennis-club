import type pino from "pino";
import type { LoggerOptions } from "pino";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ process: vi.fn(), lines: [] as string[] }));
vi.mock("pino", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof pino }>();
  // Exercise the real Pino serializers/redaction using the application's options.
  const captured = Object.assign((options: LoggerOptions) => actual.default({ ...options, level: "error" }, {
    write(line: string) { mocks.lines.push(line); },
  }), actual.default);
  return { ...actual, default: captured };
});
vi.mock("@/lib/notifications/delivery", () => ({ processPendingEmailDeliveries: mocks.process }));

import { POST } from "@/app/api/notifications/deliver/route";
import { logger } from "@/lib/logger";

const secret = "local-notification-route-test-secret";
const request = (authorized = true) => new Request("http://localhost/api/notifications/deliver", {
  method: "POST", headers: authorized ? { authorization: `Bearer ${secret}` } : {},
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lines.length = 0;
  vi.stubEnv("NOTIFICATION_CRON_SECRET", secret);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test("invocation failures retain the event and 503 response and serialize actionable errors", async () => {
  const error = new Error("Live Brevo delivery is not permitted in this environment");
  mocks.process.mockRejectedValue(error);

  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Delivery unavailable" });
  expect(mocks.lines).toHaveLength(1);
  expect(JSON.parse(mocks.lines[0])).toMatchObject({
    event: "notifications.delivery_failed", msg: "Notification delivery invocation failed",
    err: { type: "Error", message: error.message, stack: error.stack },
  });
});

test("legacy error fields also retain exception messages and stacks with redaction", () => {
  const error = Object.assign(new Error("Database unavailable"), { authorization: secret });
  logger.error({ error, token: secret }, "Invocation failed");
  expect(JSON.parse(mocks.lines[0])).toMatchObject({
    error: { message: error.message, stack: error.stack, authorization: "[Redacted]" }, token: "[Redacted]",
  });
  expect(mocks.lines[0]).not.toContain(secret);
});

test("unauthorized requests never invoke delivery", async () => {
  expect((await POST(request(false))).status).toBe(401);
  expect(mocks.process).not.toHaveBeenCalled();
});

test("successful invocations return the dispatcher summary", async () => {
  const summary = { claimed: 1, accepted: 0, sandboxAccepted: 1, retried: 0, failed: 0, stale: 0 };
  mocks.process.mockResolvedValue(summary);
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(summary);
});
