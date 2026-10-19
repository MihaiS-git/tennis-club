import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { record, logged } = vi.hoisted(() => ({ record: vi.fn(), logged: vi.fn() }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: logged, warn: logged, info: logged } }));
vi.mock("@/lib/notifications/brevo-events", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/notifications/brevo-events")>(), recordBrevoDeliveryEvent: record }));
import { POST } from "@/app/api/notifications/brevo/route";
import { parseBrevoWebhookPayload, shouldApplyProviderEvent } from "@/lib/notifications/brevo-events";

const secret = "brevo-webhook-unit-secret-0123456789abcdef";
const key = "7f000000-0000-4000-8000-000000000001";
const bounce = { event: "soft_bounce", email: "guest@example.test", id: 1, "message-id": "<m1@smtp-relay.mailin.fr>",
  ts_event: 1_800_000_000, ts_epoch: 1_800_000_000_123, "X-Mailin-custom": `booking-notification:${key}`, reason: "Mailbox\nfull" };
const request = (body: unknown, authorization?: string) => new Request("http://localhost/api/notifications/brevo",
  { method: "POST", headers: authorization ? { authorization } : {}, body: typeof body === "string" ? body : JSON.stringify(body) });
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("BREVO_WEBHOOK_SECRET", secret); record.mockResolvedValue("applied"); });
afterEach(() => vi.unstubAllEnvs());

test("delivery events are parsed with message id, submission key, sanitized reason and millisecond time", () => {
  expect(parseBrevoWebhookPayload(bounce)).toEqual({ ignored: 0, events: [{ messageId: "<m1@smtp-relay.mailin.fr>", submissionKey: key,
    event: "soft_bounce", outcome: "failed", reason: "Mailbox full", occurredAt: 1_800_000_000_123 }] });
  expect(parseBrevoWebhookPayload({ ...bounce, ts_epoch: undefined, "X-Mailin-custom": "something else" })?.events[0])
    .toMatchObject({ submissionKey: null, occurredAt: 1_800_000_000_000 });
  for (const [event, outcome] of [["delivered", "delivered"], ["deferred", "deferred"], ["hard_bounce", "failed"],
    ["invalid_email", "failed"], ["blocked", "failed"], ["error", "failed"]])
    expect(parseBrevoWebhookPayload({ ...bounce, event })?.events[0].outcome).toBe(outcome);
  // Batched payloads; engagement events are ignored, not rejected.
  expect(parseBrevoWebhookPayload([bounce, { ...bounce, event: "opened" }, { event: "spam" }])).toMatchObject({ ignored: 2 });
});

test.each([null, "text", [], { event: "delivered", ts_epoch: 1 }, { ...bounce, "message-id": "" },
  { ...bounce, ts_epoch: undefined, ts_event: undefined }, { ...bounce, ts_epoch: -1 }])("invalid delivery payload %j is rejected", payload => {
  expect(parseBrevoWebhookPayload(payload)).toBeNull();
});

test("final outcomes replace a deferral; only strictly later final events win; deferrals never replace a final outcome", () => {
  const at = (status: "deferred" | "delivered" | "failed" | null, occurredAt: number | null) => ({ status, occurredAt });
  expect(shouldApplyProviderEvent(at(null, null), { outcome: "deferred", occurredAt: 1 })).toBe(true);
  expect(shouldApplyProviderEvent(at("deferred", 5), { outcome: "failed", occurredAt: 1 })).toBe(true);
  expect(shouldApplyProviderEvent(at("deferred", 5), { outcome: "deferred", occurredAt: 5 })).toBe(false);
  expect(shouldApplyProviderEvent(at("deferred", 5), { outcome: "deferred", occurredAt: 6 })).toBe(true);
  expect(shouldApplyProviderEvent(at("delivered", 5), { outcome: "deferred", occurredAt: 9 })).toBe(false);
  expect(shouldApplyProviderEvent(at("failed", 5), { outcome: "failed", occurredAt: 5 })).toBe(false); // Duplicate.
  expect(shouldApplyProviderEvent(at("delivered", 5), { outcome: "failed", occurredAt: 4 })).toBe(false); // Older.
  expect(shouldApplyProviderEvent(at("failed", 5), { outcome: "delivered", occurredAt: 6 })).toBe(true); // Brevo retried.
});

test.each([undefined, "Bearer wrong", secret, `bearer ${secret}`, `Bearer ${secret} extra`, basic("brevo", "wrong"), "Basic !!!",
  basic(secret, "")])("rejects authorization %s without processing", async header => {
  const response = await POST(request(bounce, header));
  expect(response.status).toBe(401);
  expect(record).not.toHaveBeenCalled();
});

test.each([`Bearer ${secret}`, basic("brevo", secret)])("accepts %s and delegates each delivery event", async header => {
  record.mockResolvedValueOnce("applied").mockResolvedValueOnce("unknown");
  const response = await POST(request([bounce, { ...bounce, event: "delivered" }, { ...bounce, event: "click" }], header));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ applied: 1, duplicate: 0, unknown: 1, ignored: 1 });
  expect(record).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(logged.mock.calls)).not.toMatch(/guest@example|Mailbox|m1@|brevo-webhook-unit-secret/);
});

test.each(["", "too-short"])("an unconfigured or weak secret (%j) disables the endpoint", async value => {
  vi.stubEnv("BREVO_WEBHOOK_SECRET", value);
  expect((await POST(request(bounce, `Bearer ${value}`))).status).toBe(503);
  expect(record).not.toHaveBeenCalled();
});

test("invalid JSON or payload is rejected without logging it; processing failures ask Brevo to retry", async () => {
  expect((await POST(request("{", `Bearer ${secret}`))).status).toBe(400);
  expect((await POST(request({ ...bounce, "message-id": undefined }, `Bearer ${secret}`))).status).toBe(400);
  expect(record).not.toHaveBeenCalled();
  record.mockRejectedValue(new Error("database unavailable guest@example.test"));
  const response = await POST(request(bounce, `Bearer ${secret}`));
  expect(response.status).toBe(429);
  expect(JSON.stringify(logged.mock.calls)).not.toMatch(/guest@example|database unavailable/);
});
