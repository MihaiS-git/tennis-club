vi.mock("@/lib/db/repositories/club-settings.repository", () => ({
  readClubSettings: vi.fn(async () => ({ officialEmail: "club@example.com", senderName: "My Club", emailsEnabled: true })),
  emailDispatchAllowed: vi.fn(async () => ({ officialEmail: "club@example.com", senderName: "My Club", emailsEnabled: true })),
}));
import { beforeEach, expect, test, vi } from "vitest";
import type { EntityManager } from "typeorm";

const mocks = vi.hoisted(() => ({ profile: vi.fn(), admin: vi.fn(), fence: vi.fn(), find: vi.fn(),
  booking: vi.fn(), accounts: vi.fn(), claim: vi.fn(), complete: vi.fn(), alerts: vi.fn() }));
vi.mock("@/lib/profile/profile", () => ({ profileContext: mocks.profile }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.admin }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: (work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager) }));
vi.mock("@/lib/db/repositories/accounts.repository", () => ({ lockActiveAdminAccount: mocks.fence }));
vi.mock("@/lib/db/repositories/notifications.repository", () => ({ findMessageDelivery: mocks.find,
  findDeliveryBooking: mocks.booking, claimEmailDeliveries: mocks.claim, completeEmailAttempt: mocks.complete,
  insertEmailFailureAlerts: mocks.alerts }));
vi.mock("@/lib/notifications/recipient-resolution", () => ({ resolveNotificationAccounts: mocks.accounts }));

import { adminMessageDelivery, retryMessageDelivery } from "@/lib/notifications/admin-delivery";
import { retryEligibility, readableDeliveryError } from "@/lib/notifications/delivery-retry";

const id = "00000000-0000-4000-8000-000000000001";
const deliveryId = "00000000-0000-4000-8000-000000000002";
const delivery = { id: deliveryId, eventKey: "booking.confirmed:revision", recipientEmail: "guest@example.test",
  subject: "Booking confirmed", status: "failed" as const, attempts: 1, lastError: "Brevo HTTP 401",
  providerMessageId: null, createdAt: new Date(), updatedAt: new Date(), nextAttemptAt: new Date() };
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("BREVO_API_KEY", "mock-key"); vi.stubEnv("BOOKING_MAIL_FROM", "club@example.test");
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "sandbox");
  mocks.admin.mockResolvedValue({ userId: id }); mocks.fence.mockResolvedValue(true);
  mocks.profile.mockResolvedValue({ account: { state: "active", userId: id, roles: ["admin"] } });
  mocks.find.mockResolvedValue(delivery); mocks.booking.mockResolvedValue(id); mocks.accounts.mockResolvedValue([]);
  mocks.claim.mockResolvedValue([{ ...delivery, bodyText: "snapshot", bodyHtml: "<p>snapshot</p>", attempts: 2, lockedUntil: new Date() }]);
  mocks.complete.mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "<accepted>" }), { status: 201 })));
});

test("active Admin gets persisted delivery details via an owned notification", async () => {
  expect(await adminMessageDelivery(id)).toMatchObject({ recipientEmail: "guest@example.test", bookingHref: `/admin/bookings/${id}`,
    attempts: 1, status: "failed", retry: { eligible: true }, failureReason: expect.stringContaining("401") });
  expect(mocks.find).toHaveBeenCalledWith(expect.anything(), id, id);
});

test.each([{ state: "active", roles: [] }, { state: "suspended", roles: ["admin"] }])("non-active Admin cannot read details or retry", async account => {
  mocks.profile.mockResolvedValue({ account }); mocks.admin.mockRejectedValue(new Error("Denied"));
  expect(await adminMessageDelivery(id)).toBeNull();
  await expect(retryMessageDelivery(id)).rejects.toThrow("Denied");
  expect(mocks.find).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

test("manual retry uses the existing HTTP pipeline and claims exactly the associated delivery", async () => {
  expect(await retryMessageDelivery(id)).toContain("sandbox mode");
  expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1, null, deliveryId);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).to).toEqual([{ email: delivery.recipientEmail }]);
  expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: deliveryId,
    status: "sandbox_accepted", attempts: 2, providerMessageId: "<accepted>" }));
  expect(mocks.alerts).not.toHaveBeenCalled();
});

test("retry rechecks locked actor authorization", async () => {
  mocks.fence.mockResolvedValue(false);
  await expect(retryMessageDelivery(id)).rejects.toThrow("Active Admin");
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["accepted", "sandbox_accepted", "processing"] as const)("%s delivery is not resent", async status => {
  mocks.find.mockResolvedValue({ ...delivery, status });
  await retryMessageDelivery(id);
  expect(mocks.claim).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

test.each(["Brevo request outcome unknown", "Brevo acceptance response missing message ID", "Final delivery claim expired; provider outcome unknown", null])("ambiguous error %s is ineligible", error => {
  expect(retryEligibility({ ...delivery, lastError: error }, null).eligible).toBe(false);
});

test("cutoff and provider identity prohibit resending even failed deliveries", () => {
  expect(retryEligibility(delivery, new Date(Date.now() + 60_000)).eligible).toBe(false);
  expect(retryEligibility({ ...delivery, providerMessageId: "<accepted>" }, null).eligible).toBe(false);
  expect(readableDeliveryError(null)).toBe("Failure reason unavailable");
});

test("provider rejection is persisted and displayed without duplicate incident creation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "unauthorized", message: "Key not found" }), { status: 401 })));
  expect(await retryMessageDelivery(id)).toContain("failed");
  const completed = mocks.complete.mock.calls[0][1];
  expect(completed.lastError).toBe("Brevo HTTP 401: unauthorized: Key not found");
  mocks.find.mockResolvedValue({ ...delivery, ...completed });
  expect((await adminMessageDelivery(id))?.failureReason).toBe(completed.lastError);
  expect(mocks.alerts).toHaveBeenCalledExactlyOnceWith(expect.anything(), deliveryId, expect.any(Date));
});

test("staff recipients, deleted/unassociated messages and a lost claim never send", async () => {
  mocks.accounts.mockResolvedValue([{ email: delivery.recipientEmail, roles: ["coach"] }]);
  await retryMessageDelivery(id);
  mocks.accounts.mockResolvedValue([]); mocks.find.mockResolvedValue(null);
  await retryMessageDelivery(id);
  mocks.find.mockResolvedValue(delivery); mocks.claim.mockResolvedValue([]);
  await retryMessageDelivery(id);
  expect(fetch).not.toHaveBeenCalled();
});

test("disabled or permanently suppressed mail cannot be retried manually", async () => {
  const { readClubSettings } = await import("@/lib/db/repositories/club-settings.repository");
  vi.mocked(readClubSettings).mockResolvedValueOnce({ officialEmail: "club@example.com", senderName: "Club", emailsEnabled: false });
  expect(await retryMessageDelivery(id)).toContain("disabled");
  expect(mocks.claim).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(retryEligibility({ ...delivery, suppressedAt: new Date() }, null).eligible).toBe(false);
});
