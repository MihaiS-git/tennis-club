import type { EntityManager } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(), expired: vi.fn(), complete: vi.fn(), alerts: vi.fn(),
}));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: (work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager) }));
vi.mock("@/lib/db/repositories/notifications.repository", () => ({
  claimEmailDeliveries: mocks.claim, failExpiredFinalClaims: mocks.expired,
  completeEmailAttempt: mocks.complete, insertEmailFailureAlerts: mocks.alerts,
}));

import { sendBrevoEmail, brevoConfig } from "@/lib/notifications/brevo";
import { processPendingEmailDeliveries } from "@/lib/notifications/delivery";

const id = "00000000-0000-4000-8000-000000000001";
const claim = { id, recipientEmail: "player@example.com", subject: "Booked", bodyText: "Text",
  bodyHtml: "<p>Text</p>", attempts: 1, lockedUntil: new Date("2026-10-22T12:02:00Z") };

beforeEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks();
  vi.stubEnv("BREVO_API_KEY", "test-api-key");
  vi.stubEnv("BOOKING_MAIL_FROM", "club@example.com");
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "sandbox");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CI", "");
  mocks.claim.mockResolvedValue([claim]); mocks.expired.mockResolvedValue([]); mocks.complete.mockResolvedValue(true);
});

test("unit runner cannot inherit the development delivery database", () => {
  expect(process.env.DATABASE_URL).toBe("");
  expect(process.env.NOTIFICATION_TEST_RUNNER).toBe("1");
});

test("sandbox configures the Brevo JSON request explicitly", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "<message@brevo>" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  await sendBrevoEmail({ apiKey: "key", sender: "club@example.com", mode: "sandbox" }, claim);
  const sandbox = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(sandbox.headers).toEqual({ "X-Mailin-custom": `email_delivery_id:${id}`, "X-Sib-Sandbox": "drop" });
  expect(sandbox.to).toEqual([{ email: claim.recipientEmail }]);
  expect(fetchMock.mock.calls[0][1].headers["api-key"]).toBe("key");
});

test("a test runner cannot select live delivery even with a development environment", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "live");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  expect(brevoConfig).toThrow("not permitted");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(sendBrevoEmail({ apiKey: "key", sender: "club@example.com", mode: "live" }, claim))
    .rejects.toThrow("not permitted in automated tests");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("live delivery is rejected in automated test environments", () => {
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "live");
  expect(brevoConfig).toThrow();
  vi.stubEnv("NODE_ENV", "development");
  expect(brevoConfig).toThrow();
  vi.stubEnv("VITEST", "");
  vi.stubEnv("CI", "true");
  expect(brevoConfig).toThrow();
  vi.stubEnv("CI", "");
  expect(brevoConfig).toThrow();
  vi.stubEnv("NODE_ENV", "test");
  expect(brevoConfig).toThrow();
});

test("missing or invalid configuration fails closed, and Vercel preview rejects live", () => {
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "");
  expect(brevoConfig).toThrow();
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "invalid");
  expect(brevoConfig).toThrow();
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "sandbox");
  vi.stubEnv("BREVO_API_KEY", "");
  expect(brevoConfig).toThrow();
  vi.stubEnv("BREVO_API_KEY", "test-api-key");
  vi.stubEnv("BOOKING_MAIL_FROM", "invalid");
  expect(brevoConfig).toThrow();
  vi.stubEnv("BOOKING_MAIL_FROM", "club@example.com");
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "live");
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL", "1"); vi.stubEnv("VERCEL_ENV", "preview");
  expect(brevoConfig).toThrow();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VITEST", "");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  expect(brevoConfig).toThrow();
  vi.stubEnv("APP_URL", "https://club.example.com");
  vi.stubEnv("NOTIFICATION_TEST_RUNNER", "");
  vi.stubEnv("CI", "true");
  expect(brevoConfig().mode).toBe("live");
});

test("development sandbox acceptance persists provider message ID", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "<msg@brevo>" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await processPendingEmailDeliveries()).toMatchObject({ claimed: 1, sandboxAccepted: 1 });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).headers).toHaveProperty("X-Sib-Sandbox", "drop");
  expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    status: "sandbox_accepted", providerMessageId: "<msg@brevo>", lockedUntil: claim.lockedUntil }));
  expect(mocks.alerts).not.toHaveBeenCalled();
});

test("delivery cutoff is passed to claims and invalid cutoffs claim nothing", async () => {
  const cutoff = "2026-10-22T17:30:57.290Z";
  vi.stubEnv("NOTIFICATION_DELIVERY_NOT_BEFORE", cutoff);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "<sandbox@brevo>" }), { status: 201 })));
  await processPendingEmailDeliveries();
  expect(mocks.claim).toHaveBeenCalledWith(expect.anything(), 20, new Date(cutoff));
  vi.clearAllMocks();
  vi.stubEnv("NOTIFICATION_DELIVERY_NOT_BEFORE", "invalid");
  await expect(processPendingEmailDeliveries()).rejects.toThrow();
  expect(mocks.claim).not.toHaveBeenCalled();
});

test.each([
  [1, 5], [2, 15], [3, 60], [4, 360],
] as const)("retryable attempt %i schedules %i minutes", async (attempts, minutes) => {
  mocks.claim.mockResolvedValue([{ ...claim, attempts }]);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection lost")));
  const before = Date.now();
  expect(await processPendingEmailDeliveries()).toMatchObject({ retried: 1 });
  const input = mocks.complete.mock.calls[0][1];
  expect(input.status).toBe("pending");
  expect(input.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(minutes * 60_000);
  expect(input.nextAttemptAt.getTime() - before).toBeLessThan(minutes * 60_000 + 2_000);
});

test("nonretryable 4xx and fifth retryable attempt fail with one Admin alert", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
  expect(await processPendingEmailDeliveries()).toMatchObject({ failed: 1 });
  expect(mocks.complete.mock.calls[0][1].status).toBe("failed");
  expect(mocks.alerts).toHaveBeenCalledTimes(1);
  vi.clearAllMocks(); mocks.claim.mockResolvedValue([{ ...claim, attempts: 5 }]); mocks.expired.mockResolvedValue([]);
  mocks.complete.mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("busy", { status: 503 })));
  expect(await processPendingEmailDeliveries()).toMatchObject({ failed: 1 });
  expect(mocks.complete.mock.calls[0][1].status).toBe("failed");
});

test("stale completion cannot create an alert", async () => {
  mocks.complete.mockResolvedValue(false);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 401 })));
  expect(await processPendingEmailDeliveries()).toMatchObject({ stale: 1, failed: 0 });
  expect(mocks.alerts).not.toHaveBeenCalled();
});

test("expired fifth claim fails without a sixth provider request", async () => {
  mocks.expired.mockResolvedValue([id]); mocks.claim.mockResolvedValue([]);
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  expect(await processPendingEmailDeliveries()).toMatchObject({ claimed: 0, failed: 1 });
  expect(mocks.claim).toHaveBeenCalledWith(expect.anything(), 19, null);
  expect(mocks.alerts).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});
