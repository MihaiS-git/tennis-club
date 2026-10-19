import { beforeEach, expect, test, vi } from "vitest";
import { inboxHref, inboxPageSize, parseInboxQuery } from "@/lib/notifications/inbox-query";
const { account, query } = vi.hoisted(() => ({ account: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
import { listOwnNotifications, manageOwnNotifications, markOwnNotificationRead, readOwnNotification, readOwnUnreadNotifications, readNotificationIndicators } from "@/lib/notifications/financial-notices";
const id = "bc000000-0000-4000-8000-000000000001";
const owner = "bc000000-0000-4000-8000-000000000002";
beforeEach(() => { vi.resetAllMocks(); account.mockResolvedValue({ state: "active", userId: owner }); });

test("normalizes inbox URL parameters and preserves filters when changing pages", () => {
  const parsed = parseInboxQuery({ q: " refund ", status: "unread", type: "refund_incomplete", sort: "oldest", page: "3" });
  expect(inboxHref(parsed, { page: 4 })).toBe("/my-activity/notifications?q=refund&status=unread&type=refund_incomplete&sort=oldest&page=4");
  expect(parseInboxQuery({ status: "invalid", sort: "DROP", page: "-1" })).toEqual(parseInboxQuery());
  expect(inboxPageSize).toBe(25);
});

test.each(["unauthenticated", "suspended"])("%s cannot read or mutate inbox", async state => {
  account.mockResolvedValue({ state });
  expect((await listOwnNotifications()).notices).toEqual([]);
  expect(await manageOwnNotifications({ ids: [id], operation: "read" })).toMatchObject({ ok: false });
  expect(query).not.toHaveBeenCalled();
});

test.each([
  { ids: [], operation: "read" }, { ids: [id, id], operation: "delete" },
  { ids: ["bad"], operation: "unread" }, { ids: [id], operation: "invalid" },
  { ids: Array.from({ length: 26 }, () => id), operation: "delete" },
])("rejects invalid or oversized bulk input before persistence: %o", async input => {
  expect(await manageOwnNotifications(input)).toMatchObject({ ok: false });
  expect(query).not.toHaveBeenCalled();
});

test.each(["read", "unread", "delete"])("%s is scoped to the authoritative account and changes only inbox columns", async operation => {
  query.mockResolvedValue([{ id }]);
  expect(await manageOwnNotifications({ ids: [id], operation, accountUserId: id })).toEqual({ ok: true });
  const [sql, args] = query.mock.calls[0];
  expect(args).toEqual([[id], owner]);
  expect(sql).toContain("account_user_id=$2 AND deleted_at IS NULL");
  expect(sql).not.toMatch(/booking_notification_deliveries|acknowledged_at|public.bookings|payment/);
});

test("a missing or foreign inbox item cannot be changed", async () => {
  query.mockResolvedValue([]);
  expect(await manageOwnNotifications({ ids: [id], operation: "delete" })).toMatchObject({ ok: false });
});

test("automatic reads are owner-scoped, idempotent and independent of financial acknowledgment", async () => {
  query.mockResolvedValue([{ id }]);
  expect(await markOwnNotificationRead(id)).toEqual({ ok: true });
  expect(await markOwnNotificationRead(id)).toEqual({ ok: true });
  for (const [sql, args] of query.mock.calls) {
    expect(args).toEqual([[id], owner]);
    expect(sql).toContain("read_at=COALESCE(read_at,clock_timestamp())");
    expect(sql).toContain("account_user_id=$2 AND deleted_at IS NULL");
    expect(sql).not.toMatch(/acknowledged_at|booking_notification_deliveries|payment/);
  }
});

test("automatic reads reject foreign notifications and inactive accounts", async () => {
  query.mockResolvedValue([]);
  expect(await markOwnNotificationRead(id)).toMatchObject({ ok: false });
  query.mockClear();
  account.mockResolvedValue({ state: "suspended" });
  expect(await markOwnNotificationRead(id)).toMatchObject({ ok: false });
  expect(query).not.toHaveBeenCalled();
});

test("details reject malformed identifiers and inactive accounts before persistence", async () => {
  expect(await readOwnNotification("invalid")).toBeNull();
  account.mockResolvedValue({ state: "suspended" });
  expect(await readOwnNotification(id)).toBeNull();
  expect(await readOwnUnreadNotifications()).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

test("details and unread reads enforce ownership, exclude deletion, and expose no provider data", async () => {
  query.mockResolvedValueOnce([]);
  expect(await readOwnNotification(id)).toBeNull();
  expect(query.mock.calls[0][1]).toEqual([id, owner]);
  expect(query.mock.calls[0][0]).toContain("id=$1 AND account_user_id=$2 AND deleted_at IS NULL");
  query.mockResolvedValueOnce([{ unread: true }]);
  expect(await readOwnUnreadNotifications()).toBe(true);
  expect(query.mock.calls[1][1]).toEqual([owner]);
  expect(query.mock.calls[1][0]).toContain("SELECT EXISTS");
  expect(query.mock.calls[1][0]).toContain("deleted_at IS NULL AND read_at IS NULL");
});

test.each([
  ["member", [], [{ unread: true }], { unread: true }],
  ["coach", ["coach"], [{ unread: false }], { unread: false }],
  ["Admin with unread personal notifications", ["admin"], [{ unread: true }, { alerts: false }], { unread: true, adminAlerts: false }],
  ["Admin with unresolved alerts", ["admin"], [{ unread: false }, { alerts: true }], { unread: false, adminAlerts: true }],
  ["Admin with both", ["admin"], [{ unread: true }, { alerts: true }], { unread: true, adminAlerts: true }],
  ["Admin with neither", ["admin"], [{ unread: false }, { alerts: false }], { unread: false, adminAlerts: false }],
])("navbar indicators for a %s", async (_name, roles, results, expected) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles });
  for (const result of results) query.mockResolvedValueOnce([result]);
  expect(await readNotificationIndicators()).toEqual(expected);
  expect(query).toHaveBeenCalledTimes(results.length);
  expect(query.mock.calls[0][1]).toEqual([owner]);
  if (!roles.includes("admin")) expect(query.mock.calls.flat().join(" ")).not.toContain("booking_notification_deliveries");
});

test("Admin alerts count only undelivered, undismissed stopped or Brevo-failed rows, or unacknowledged financial exceptions", async () => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["admin"] });
  query.mockResolvedValueOnce([{ unread: false }]).mockResolvedValueOnce([{ alerts: false }]);
  await readNotificationIndicators();
  const sql = String(query.mock.calls[1][0]);
  expect(sql).toContain("FROM public.booking_notification_deliveries");
  expect(sql).toContain("WHERE delivered_at IS NULL AND dismissed_at IS NULL AND (");
  expect(sql).toContain(" IN ('stopped','failed') OR (requires_acknowledgement AND acknowledged_at IS NULL)");
  expect(query.mock.calls[1]).toHaveLength(1);
});

test.each(["unauthenticated", "suspended"])("a %s Admin receives no indicator data and no query runs", async state => {
  account.mockResolvedValue({ state, userId: owner, roles: ["admin"] });
  expect(await readNotificationIndicators()).toEqual({ unread: false });
  expect(query).not.toHaveBeenCalled();
});
