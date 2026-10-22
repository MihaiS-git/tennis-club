import type { EntityManager } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deliver: vi.fn(), webhook: vi.fn() }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: (work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager) }));
vi.mock("@/lib/notifications/delivery", () => ({ processPendingEmailDeliveries: mocks.deliver }));
vi.mock("@/lib/notifications/webhook", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/notifications/webhook")>(),
  processBrevoFailureWebhook: mocks.webhook,
}));

import { claimEmailDeliveries, completeEmailAttempt, failEmailFromWebhook } from "@/lib/db/repositories/notifications.repository";
import { POST as cronPost } from "@/app/api/notifications/deliver/route";
import { POST as webhookPost } from "@/app/api/notifications/brevo-webhook/route";

const id = "00000000-0000-4000-8000-000000000001";
const cronSecret = "local-cron-secret-at-least-32-chars";
const webhookSecret = "local-webhook-secret-at-least-32-chars";
beforeEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  vi.stubEnv("NOTIFICATION_CRON_SECRET", cronSecret);
  vi.stubEnv("BREVO_WEBHOOK_SECRET", webhookSecret);
});

test("atomic concurrent claims use SKIP LOCKED and stale completion checks attempt and lease", async () => {
  let locked = false;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FOR UPDATE SKIP LOCKED")) {
      if (locked) return [[], 0];
      locked = true;
      return [[{ id, recipient_email: "player@example.com", subject: "Hi", body_text: "Text",
        body_html: "<p>Text</p>", attempts: 1, locked_until: new Date() }], 1];
    }
    return [[], 0];
  });
  const manager = { query } as unknown as EntityManager;
  const [first, second] = await Promise.all([claimEmailDeliveries(manager, 20), claimEmailDeliveries(manager, 20)]);
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(0);
  expect(query.mock.calls[0][0]).toContain("FOR UPDATE SKIP LOCKED");
  await completeEmailAttempt(manager, { id, attempts: 1, lockedUntil: first[0].lockedUntil,
    status: "accepted", nextAttemptAt: new Date(), providerMessageId: "msg", lastError: null });
  expect(query.mock.calls[2][0]).toContain("attempts=$2 AND locked_until=$3");
});

test("webhook lookup binds recipient and provider ID, with optional UUID correlation", async () => {
  const query = vi.fn().mockResolvedValue([[{ id }], 1]);
  await failEmailFromWebhook({ query } as unknown as EntityManager, {
    recipientEmail: "player@example.com", messageId: "msg@brevo", deliveryId: id, reason: "blocked" });
  expect(query.mock.calls[0][0]).toContain("lower(recipient_email)=lower($1)");
  expect(query.mock.calls[0][0]).toContain("status IN ('accepted', 'processing', 'pending')");
  expect(query.mock.calls[0][1]).toEqual(["player@example.com", "msg@brevo", id, "blocked"]);
});

test("invalid Cron and webhook Bearer tokens are rejected before processing", async () => {
  expect((await cronPost(new Request("http://localhost/api/notifications/deliver", { method: "POST" }))).status).toBe(401);
  expect((await webhookPost(new Request("http://localhost/api/notifications/brevo-webhook", {
    method: "POST", headers: { authorization: "Bearer wrong" }, body: "not-json" }))).status).toBe(401);
  expect(mocks.deliver).not.toHaveBeenCalled();
  expect(mocks.webhook).not.toHaveBeenCalled();
});

test("authenticated Cron returns only compact counts", async () => {
  mocks.deliver.mockResolvedValue({ claimed: 1, accepted: 1, sandboxAccepted: 0, retried: 0, failed: 0, stale: 0 });
  const response = await cronPost(new Request("http://localhost/api/notifications/deliver", {
    method: "POST", headers: { authorization: `Bearer ${cronSecret}` } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ claimed: 1, accepted: 1, sandboxAccepted: 0, retried: 0, failed: 0, stale: 0 });
});
