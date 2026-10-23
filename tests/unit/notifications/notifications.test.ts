vi.mock("@/lib/db/repositories/club-settings.repository", () => ({
  readClubSettings: vi.fn(async () => ({ officialEmail: "club@example.com", senderName: "My Club", emailsEnabled: true })),
  emailDispatchAllowed: vi.fn(async () => ({ officialEmail: "club@example.com", senderName: "My Club", emailsEnabled: true })),
}));
import type { EntityManager } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";
import { resolveNotificationChannels } from "@/lib/notifications/policy";
import type { NotificationAccount } from "@/lib/notifications/types";

const account = (roles: string[] = [], verified = true): NotificationAccount => ({
  userId: "00000000-0000-4000-8000-000000000001", email: "player@example.com",
  authEmail: "PLAYER@example.com", emailConfirmed: verified, active: true, roles,
});

test.each([
  ["guest", [], { email: true, userIds: [] }],
  ["member", [account()], { email: true, userIds: [account().userId] }],
  ["unverified", [account([], false)], { email: true, userIds: [] }],
  ["coach", [account(["coach"])], { email: false, userIds: [account().userId] }],
  ["admin", [account(["admin"])], { email: false, userIds: [account().userId] }],
  ["multiple roles", [account(["admin", "coach"])], { email: false, userIds: [account().userId] }],
] as const)("customer channels for %s", (_name, accounts, expected) => {
  expect(resolveNotificationChannels("PLAYER@EXAMPLE.COM", accounts, "customer")).toEqual(expected);
});

test("auth email must match and be verified; employee suppression takes priority", () => {
  const changed = { ...account(), authEmail: "new@example.com" };
  expect(resolveNotificationChannels(account().email, [changed], "customer"))
    .toEqual({ email: true, userIds: [] });
  expect(resolveNotificationChannels(account().email, [account(["coach"], false)], "customer"))
    .toEqual({ email: false, userIds: [] });
  expect(resolveNotificationChannels(account().email, [account(["admin"])], "admin_operational"))
    .toEqual({ email: false, userIds: [account().userId] });
  expect(resolveNotificationChannels(account().email, [account()], "admin_operational"))
    .toEqual({ email: false, userIds: [] });
});

const { messages, deliveries } = vi.hoisted(() => ({ messages: new Map<string, unknown>(), deliveries: new Map<string, unknown>() }));
vi.mock("@/lib/db/repositories/notifications.repository", () => ({
  insertUserMessage: vi.fn(async (_manager, message: { userId: string; eventKey: string }) => {
    messages.set(`${message.userId}:${message.eventKey}`, message);
  }),
  insertEmailDelivery: vi.fn(async (_manager, delivery: { eventKey: string; recipientEmail: string }) => {
    deliveries.set(`${delivery.eventKey}:${delivery.recipientEmail.toLowerCase()}`, delivery);
  }),
}));
import { recordNotification } from "@/lib/notifications/record";

const event = { eventKey: "booking:123:confirmed", purpose: "customer" as const,
  recipientEmail: "player@example.com", kind: "booking_confirmed", subject: "Confirmed",
  bodyText: "Court booked", bodyHtml: "<p>Court booked</p>", occurredAt: new Date("2026-10-22T10:00:00Z") };
const row = (roles: string | null = null, confirmed = true) => ({
  user_id: account().userId, email: account().email, auth_email: account().authEmail,
  email_confirmed: confirmed, active: true, role_code: roles,
});

beforeEach(() => { messages.clear(); deliveries.clear(); });

test("recording is idempotent and binds the in-app message to the resolved account", async () => {
  const manager = { query: vi.fn().mockResolvedValue([row()]) } as unknown as EntityManager;
  await recordNotification(manager, event);
  await recordNotification(manager, event);
  expect(messages.size).toBe(1);
  expect(deliveries.size).toBe(1);
  expect([...messages.values()][0]).toMatchObject({ userId: account().userId, eventKey: event.eventKey });
  expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("JOIN auth.users"), [event.recipientEmail]);
});

test("guest receives email only; admin receives in-app only", async () => {
  const manager = { query: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row("admin")]) } as unknown as EntityManager;
  await recordNotification(manager, event);
  expect(messages.size).toBe(0);
  expect(deliveries.size).toBe(1);
  deliveries.clear();
  await recordNotification(manager, { ...event, eventKey: "booking:124:confirmed" });
  expect(messages.size).toBe(1);
  expect(deliveries.size).toBe(0);
});

test("repository inserts use database conflict handling", async () => {
  const repository = await vi.importActual<typeof import("@/lib/db/repositories/notifications.repository")>(
    "@/lib/db/repositories/notifications.repository");
  const execute = vi.fn().mockResolvedValue({});
  const builder = { insert: vi.fn(), values: vi.fn(), orIgnore: vi.fn(), execute };
  builder.insert.mockReturnValue(builder);
  builder.values.mockReturnValue(builder);
  builder.orIgnore.mockReturnValue(builder);
  const manager = { getRepository: vi.fn().mockReturnValue({ createQueryBuilder: () => builder }) } as unknown as EntityManager;
  await repository.insertUserMessage(manager, { id: account().userId, userId: account().userId,
    eventKey: event.eventKey, kind: event.kind, subject: event.subject, bodyText: event.bodyText,
    href: null, createdAt: event.occurredAt });
  await repository.insertEmailDelivery(manager, { id: account().userId, eventKey: event.eventKey,
    recipientEmail: event.recipientEmail, subject: event.subject, bodyText: event.bodyText,
    bodyHtml: event.bodyHtml, status: "pending", attempts: 0, nextAttemptAt: event.occurredAt,
    lockedUntil: null, providerMessageId: null, lastError: null,
    createdAt: event.occurredAt, updatedAt: event.occurredAt });
  expect(builder.orIgnore).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledTimes(2);
});

test("disabled customer mail preserves the account's in-app notification", async () => {
  const { readClubSettings } = await import("@/lib/db/repositories/club-settings.repository");
  vi.mocked(readClubSettings).mockResolvedValueOnce({ officialEmail: "", senderName: "", emailsEnabled: false });
  const manager = { query: vi.fn().mockResolvedValue([row()]) } as unknown as EntityManager;
  await recordNotification(manager, event);
  expect(messages.size).toBe(1); expect(deliveries.size).toBe(0);
});
