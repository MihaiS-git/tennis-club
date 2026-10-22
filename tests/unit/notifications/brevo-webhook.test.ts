import type { EntityManager } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fail: vi.fn(), alerts: vi.fn() }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: (work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager) }));
vi.mock("@/lib/db/repositories/notifications.repository", () => ({
  failEmailFromWebhook: mocks.fail, insertEmailFailureAlerts: mocks.alerts,
}));

import { processBrevoFailureWebhook } from "@/lib/notifications/webhook";

const id = "00000000-0000-4000-8000-000000000001";
const payload = { event: "hard_bounce", email: "player@example.com", "message-id": "msg@brevo",
  "X-Mailin-custom": `email_delivery_id:${id}`, reason: "Mailbox unavailable" };

beforeEach(() => { vi.clearAllMocks(); });

test("terminal webhook creates one Admin alert and duplicate is harmless", async () => {
  mocks.fail.mockResolvedValueOnce(id).mockResolvedValueOnce(null);
  expect(await processBrevoFailureWebhook(payload)).toBe("failed");
  expect(await processBrevoFailureWebhook(payload)).toBe("duplicate");
  expect(mocks.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    recipientEmail: payload.email, messageId: payload["message-id"], deliveryId: id }));
  expect(mocks.alerts).toHaveBeenCalledTimes(1);
});

test("nonterminal events are ignored and malformed terminal payloads are rejected", async () => {
  expect(await processBrevoFailureWebhook({ event: "opened" })).toBe("ignored");
  await expect(processBrevoFailureWebhook({ event: "blocked", email: "bad" })).rejects.toThrow();
  expect(mocks.fail).not.toHaveBeenCalled();
});
