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

const { messages, deliveries, insertMessages } = vi.hoisted(() => ({
  messages: new Map<string, unknown>(), deliveries: new Map<string, unknown>(),
  insertMessages: vi.fn(async (_manager, batch: readonly { userId: string; eventKey: string }[]) => {
    for (const message of batch) {
      const key = `${message.userId}:${message.eventKey}`;
      if (!messages.has(key)) messages.set(key, message);
    }
  }),
}));
// Account lookup runs for real against each test's manager.query rows.
vi.mock("@/lib/db/repositories/notifications.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db/repositories/notifications.repository")>(),
  insertUserMessages: insertMessages,
  insertEmailDelivery: vi.fn(async (_manager, delivery: { eventKey: string; recipientEmail: string }) => {
    deliveries.set(`${delivery.eventKey}:${delivery.recipientEmail.toLowerCase()}`, delivery);
  }),
}));
import { recordNotification } from "@/lib/notifications/record";

const event = { eventKey: "booking:123:confirmed", purpose: "customer" as const,
  recipientEmail: "player@example.com", kind: "booking_confirmed", subject: "Confirmed",
  bodyText: "Court booked", bodyHtml: "<p>Court booked</p>", occurredAt: new Date("2026-10-22T10:00:00Z") };
const row = (roles: string | null = null, confirmed = true, userId = account().userId) => ({
  user_id: userId, email: account().email, auth_email: account().authEmail,
  email_confirmed: confirmed, active: true, role_code: roles,
});

beforeEach(() => { messages.clear(); deliveries.clear(); insertMessages.mockReset().mockImplementation(async (_manager, batch) => {
  for (const message of batch) {
    const key = `${message.userId}:${message.eventKey}`;
    if (!messages.has(key)) messages.set(key, message);
  }
}); });

test("guest receives email only; admin receives in-app only", async () => {
  const manager = { query: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row("admin")]) } as unknown as EntityManager;
  await recordNotification(manager, event);
  expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("JOIN auth.users"), [event.recipientEmail]);
  expect(insertMessages).toHaveBeenCalledExactlyOnceWith(manager, []);
  expect(messages.size).toBe(0);
  expect(deliveries.size).toBe(1);
  deliveries.clear();
  await recordNotification(manager, { ...event, eventKey: "booking:124:confirmed" });
  expect(insertMessages).toHaveBeenNthCalledWith(2, manager, [expect.objectContaining({
    userId: account().userId, eventKey: "booking:124:confirmed", kind: event.kind,
    subject: event.subject, bodyText: event.bodyText, href: null, createdAt: event.occurredAt,
  })]);
  expect(messages.size).toBe(1);
  expect(deliveries.size).toBe(0);
});

test("multiple accounts use one batch and replayed event keys remain deduplicated", async () => {
  const secondId = "00000000-0000-4000-8000-000000000002";
  const manager = { query: vi.fn().mockResolvedValue([row("admin"), row("admin", true, secondId)]) } as unknown as EntityManager;
  await recordNotification(manager, event);
  expect(insertMessages).toHaveBeenCalledExactlyOnceWith(manager, [
    expect.objectContaining({ userId: account().userId, eventKey: event.eventKey }),
    expect.objectContaining({ userId: secondId, eventKey: event.eventKey }),
  ]);
  expect(messages.size).toBe(2);
  await recordNotification(manager, event);
  expect(insertMessages).toHaveBeenCalledTimes(2);
  expect(messages.size).toBe(2);
  expect(deliveries.size).toBe(0);
});

test("batch failure propagates on the caller's transaction before email persistence", async () => {
  const failure = new Error("insert failed");
  insertMessages.mockRejectedValueOnce(failure);
  const manager = { query: vi.fn().mockResolvedValue([row()]),
    queryRunner: { isTransactionActive: true } } as unknown as EntityManager;
  await expect(recordNotification(manager, event)).rejects.toBe(failure);
  expect(insertMessages).toHaveBeenCalledExactlyOnceWith(manager, [expect.objectContaining({
    userId: account().userId, eventKey: event.eventKey,
  })]);
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

test("batched user messages issue one conflict-ignoring insert per bounded chunk", async () => {
  const repository = await vi.importActual<typeof import("@/lib/db/repositories/notifications.repository")>(
    "@/lib/db/repositories/notifications.repository");
  const execute = vi.fn().mockResolvedValue({});
  const builder = { insert: vi.fn(), values: vi.fn(), orIgnore: vi.fn(), execute };
  for (const step of [builder.insert, builder.values, builder.orIgnore]) step.mockReturnValue(builder);
  const manager = { getRepository: vi.fn().mockReturnValue({ createQueryBuilder: () => builder }) } as unknown as EntityManager;
  const message = (index: number) => ({ id: `${index}`, userId: `${index}`, eventKey: event.eventKey, kind: event.kind,
    subject: event.subject, bodyText: event.bodyText, href: null, createdAt: event.occurredAt });
  await repository.insertUserMessages(manager, []);
  expect(execute).not.toHaveBeenCalled();
  await repository.insertUserMessages(manager, [message(1), message(2), message(3)]);
  expect(execute).toHaveBeenCalledOnce();
  expect(builder.orIgnore).toHaveBeenCalledOnce();
  expect(builder.values).toHaveBeenCalledWith([1, 2, 3].map(index => ({ ...message(index), readAt: null, deletedAt: null })));
  execute.mockClear();
  await repository.insertUserMessages(manager, Array.from({ length: 2001 }, (_, index) => message(index)));
  expect(execute).toHaveBeenCalledTimes(3);
  expect(builder.values.mock.calls.slice(1).map(call => call[0].length)).toEqual([1000, 1000, 1]);
});

test("staff role lookups filter active accounts through the supplied manager", async () => {
  const repository = await vi.importActual<typeof import("@/lib/db/repositories/notifications.repository")>(
    "@/lib/db/repositories/notifications.repository");
  const { UserEntity } = await import("@/lib/db/entities/user.entity");
  const builder = { select: vi.fn(), innerJoin: vi.fn(), where: vi.fn(), andWhere: vi.fn(), orderBy: vi.fn(),
    getExists: vi.fn().mockResolvedValue(true), getMany: vi.fn().mockResolvedValue([{ id: account().userId }]) };
  for (const step of [builder.select, builder.innerJoin, builder.where, builder.andWhere, builder.orderBy]) step.mockReturnValue(builder);
  const manager = { getRepository: vi.fn().mockReturnValue({ createQueryBuilder: () => builder }) } as unknown as EntityManager;
  expect(await repository.hasActiveUserRole(manager, account().userId, "coach")).toBe(true);
  expect(await repository.listActiveUserIdsWithRole(manager, "admin")).toEqual([account().userId]);
  expect(manager.getRepository).toHaveBeenCalledWith(UserEntity);
  expect(builder.where).toHaveBeenNthCalledWith(1, expect.stringContaining("account.status = 'active'"), { roleCode: "coach" });
  expect(builder.where).toHaveBeenNthCalledWith(2, expect.stringContaining("account.status = 'active'"), { roleCode: "admin" });
  expect(builder.andWhere).toHaveBeenCalledWith("account.id = :userId", { userId: account().userId });
});

test("disabled customer mail preserves the account's in-app notification", async () => {
  const { readClubSettings } = await import("@/lib/db/repositories/club-settings.repository");
  vi.mocked(readClubSettings).mockResolvedValueOnce({ officialEmail: "", senderName: "", emailsEnabled: false });
  const manager = { query: vi.fn().mockResolvedValue([row()]) } as unknown as EntityManager;
  await recordNotification(manager, event);
  expect(messages.size).toBe(1); expect(deliveries.size).toBe(0);
});
