import { beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { context, repository, dataSource } = vi.hoisted(() => ({
  context: vi.fn(), dataSource: vi.fn(),
  repository: { listUserMessages: vi.fn(), countUserMessages: vi.fn(), countUnreadUserMessages: vi.fn(),
    findUserMessage: vi.fn(), markUserMessageRead: vi.fn(), markUserMessageUnread: vi.fn(), updateUserMessages: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/profile/profile", () => ({ profileContext: context }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: dataSource }));
vi.mock("@/lib/db/repositories/notifications.repository", () => repository);

import { inboxPage, listOwnMessages, messageAccess, openOwnMessage, readOwnMessage, safeMessageHref,
  unreadOwnMessage, unreadOwnMessageCount, updateOwnMessages, deleteOwnMessage } from "@/lib/notifications/inbox";
import { inboxHref, parseInboxQuery } from "@/lib/notifications/inbox-query";
import { GET } from "@/app/api/messages/unread-count/route";
import MessagesPage from "@/app/messages/page";
import { deleteMessageAction, updateSelectedMessagesAction } from "@/app/messages/actions";

const owner = "00000000-0000-4000-8000-000000000001";
const messageId = "00000000-0000-4000-8000-000000000002";
const manager = {};

beforeEach(() => {
  vi.clearAllMocks();
  dataSource.mockResolvedValue({ manager });
  context.mockResolvedValue({ account: { state: "active", userId: owner, roles: [] } });
});

test("unauthenticated account cannot access messages or unread endpoint", async () => {
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  expect(await messageAccess()).toEqual({ state: "unauthenticated" });
  const response = await GET();
  expect(response.status).toBe(401);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(dataSource).not.toHaveBeenCalled();
});

test("owner-scoped lookup is read-only; the open action marks only the owned message read", async () => {
  const row = { id: messageId, userId: owner, readAt: null };
  repository.findUserMessage.mockResolvedValueOnce(row).mockResolvedValueOnce(row).mockResolvedValueOnce(null);
  const opened = await openOwnMessage(owner, messageId);
  expect(opened?.readAt).toBeNull();
  expect(repository.findUserMessage).toHaveBeenCalledWith(manager, owner, messageId);
  expect(repository.markUserMessageRead).not.toHaveBeenCalled();
  expect(await readOwnMessage(owner, messageId)).toBe(true);
  expect(repository.markUserMessageRead).toHaveBeenCalledWith(manager, owner, messageId, expect.any(Date));
  expect(await readOwnMessage(owner, messageId)).toBe(false);
  expect(repository.markUserMessageRead).toHaveBeenCalledTimes(1);
});

test("mark unread updates only an owned message and is harmless on repeat", async () => {
  repository.findUserMessage.mockResolvedValueOnce({ id: messageId, userId: owner, readAt: new Date() })
    .mockResolvedValueOnce({ id: messageId, userId: owner, readAt: null }).mockResolvedValueOnce(null);
  expect(await unreadOwnMessage(owner, messageId)).toBe(true);
  expect(await unreadOwnMessage(owner, messageId)).toBe(true);
  expect(await unreadOwnMessage(owner, messageId)).toBe(false);
  expect(repository.markUserMessageUnread).toHaveBeenCalledTimes(2);
  expect(repository.markUserMessageUnread).toHaveBeenCalledWith(manager, owner, messageId);
});

test("bulk and individual mutations use the verified owner and reject invalid selections", async () => {
  const second = "00000000-0000-4000-8000-000000000003";
  repository.updateUserMessages.mockResolvedValue(2);
  for (const operation of ["read", "unread", "delete"] as const) {
    expect(await updateSelectedMessagesAction([messageId, second], operation)).toEqual({ updated: 2 });
    expect(repository.updateUserMessages).toHaveBeenLastCalledWith(manager, owner, [messageId, second], operation);
  }
  repository.updateUserMessages.mockResolvedValue(1);
  expect(await deleteMessageAction(messageId)).toEqual({ ok: true });
  expect(repository.updateUserMessages).toHaveBeenLastCalledWith(manager, owner, [messageId], "delete");
  await expect(updateOwnMessages(owner, [messageId, messageId], "read")).rejects.toThrow();
  await expect(deleteOwnMessage(owner, "invalid")).rejects.toThrow();
  expect(repository.updateUserMessages).toHaveBeenCalledTimes(4);
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  await expect(updateSelectedMessagesAction([messageId], "delete")).rejects.toThrow("Authentication required");
  await expect(deleteMessageAction(messageId)).rejects.toThrow("Authentication required");
  expect(repository.updateUserMessages).toHaveBeenCalledTimes(4);
});

test("repository soft deletes only active owned IDs and event replay cannot restore them", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/repositories/notifications.repository")>("@/lib/db/repositories/notifications.repository");
  const builder = { insert: vi.fn(), values: vi.fn(), orIgnore: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn(),
    execute: vi.fn().mockResolvedValue({ affected: 1 }), getCount: vi.fn().mockResolvedValue(0) };
  for (const key of ["insert", "values", "orIgnore", "update", "set", "where"] as const)
    builder[key].mockReturnValue(builder);
  const findOneBy = vi.fn().mockResolvedValue(null);
  const scopedManager = { getRepository: () => ({ createQueryBuilder: () => builder, findOneBy }) };
  const message = { id: messageId, userId: owner, eventKey: "booking.confirmed:one", kind: "booking.confirmed",
    subject: "Confirmed", bodyText: "Court", href: null, createdAt: new Date() };
  await actual.insertUserMessage(scopedManager as never, message);
  await actual.insertUserMessage(scopedManager as never, message);
  expect(builder.orIgnore).toHaveBeenCalledTimes(2);
  expect(builder.values).toHaveBeenCalledWith({ ...message, readAt: null, deletedAt: null });
  expect(builder.update).not.toHaveBeenCalled();
  expect(await actual.updateUserMessages(scopedManager as never, owner, [messageId], "delete")).toBe(1);
  expect(builder.set).toHaveBeenLastCalledWith({ deletedAt: expect.any(Function) });
  expect(builder.where).toHaveBeenLastCalledWith("user_id = :userId AND deleted_at IS NULL AND id IN (:...ids)",
    { userId: owner, ids: [messageId] });
  await actual.updateUserMessages(scopedManager as never, owner, [messageId], "read");
  expect(builder.where).toHaveBeenLastCalledWith("user_id = :userId AND deleted_at IS NULL AND id IN (:...ids) AND read_at IS NULL",
    { userId: owner, ids: [messageId] });
  await actual.updateUserMessages(scopedManager as never, owner, [messageId], "unread");
  expect(builder.set).toHaveBeenLastCalledWith({ readAt: null });
  expect(builder.where).toHaveBeenLastCalledWith("user_id = :userId AND deleted_at IS NULL AND id IN (:...ids) AND read_at IS NOT NULL",
    { userId: owner, ids: [messageId] });
  await actual.markUserMessageRead(scopedManager as never, owner, messageId, new Date());
  expect(builder.where).toHaveBeenLastCalledWith("id = :id AND user_id = :userId AND read_at IS NULL AND deleted_at IS NULL",
    { id: messageId, userId: owner });
  await actual.markUserMessageUnread(scopedManager as never, owner, messageId);
  expect(builder.where).toHaveBeenLastCalledWith("id = :id AND user_id = :userId AND read_at IS NOT NULL AND deleted_at IS NULL",
    { id: messageId, userId: owner });
  await actual.findUserMessage(scopedManager as never, owner, messageId);
  expect(findOneBy).toHaveBeenCalledWith(expect.objectContaining({ userId: owner, id: messageId, deletedAt: expect.anything() }));
  await actual.countUnreadUserMessages(scopedManager as never, owner);
  expect(builder.where).toHaveBeenLastCalledWith(
    "message.userId = :userId AND message.readAt IS NULL AND message.deletedAt IS NULL", { userId: owner });
});

test("pagination uses 25 owner-scoped rows; unread count is owner-scoped and uncached", async () => {
  repository.listUserMessages.mockResolvedValue([]);
  repository.countUserMessages.mockResolvedValue(51);
  repository.countUnreadUserMessages.mockResolvedValue(3);
  expect(inboxPage("2")).toBe(2);
  expect(inboxPage("bad")).toBe(1);
  const query = parseInboxQuery({ page: "2", q: "  Lesson  ", status: "unread", category: "coaching", sort: "subject_asc" });
  expect(await listOwnMessages(owner, query)).toMatchObject({ page: 2, total: 51, hasPrevious: true, hasNext: true });
  expect(repository.listUserMessages).toHaveBeenCalledWith(manager, owner, query, 25, 25);
  expect(repository.countUserMessages).toHaveBeenCalledWith(manager, owner, query);
  expect(inboxHref({ ...query, page: 3 })).toBe("/messages?q=Lesson&status=unread&category=coaching&sort=subject_asc&page=3");
  expect(await unreadOwnMessageCount(owner)).toBe(3);
  const response = await GET();
  expect(await response.json()).toEqual({ unreadCount: 3 });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(repository.countUnreadUserMessages).toHaveBeenCalledWith(manager, owner);
});

test("invalid inbox controls fall back safely, and a new search starts on page one", () => {
  expect(parseInboxQuery({ q: "  Court  ", status: "bad", category: "bad", sort: "bad", page: "bad" }))
    .toEqual({ q: "Court", status: "all", category: "all", sort: "newest", page: 1 });
  expect(parseInboxQuery({ q: "Court", status: "read", category: "bookings", sort: "oldest" }).page).toBe(1);
});

test("missing, repeated and out-of-range inbox parameters fall back to their defaults", () => {
  const defaults = { q: "", status: "all", category: "all", sort: "newest", page: 1 };
  expect(parseInboxQuery({})).toEqual(defaults);
  expect(parseInboxQuery({ q: ["Court", "Lesson"], status: ["read", "unread"], category: ["club", "payments"], sort: ["oldest", "newest"], page: ["2", "3"] }))
    .toEqual(defaults);
  expect(parseInboxQuery({ status: "READ", category: " club", sort: "oldest " })).toEqual(defaults);
  for (const page of ["", "0", "-1", "1.5", "100001", "Infinity"]) expect(inboxPage(page)).toBe(1);
  expect(inboxPage("100000")).toBe(100000);
});

test("inbox toolbar keeps active controls and detail/pagination links retain them", async () => {
  repository.listUserMessages.mockResolvedValue([{ id: messageId, kind: "booking.confirmed", subject: "Court confirmed",
    bodyText: "Court A", readAt: null, createdAt: new Date("2026-10-22T10:00:00Z") }]);
  repository.countUserMessages.mockResolvedValue(76);
  const html = renderToStaticMarkup(await MessagesPage({ searchParams: Promise.resolve({
    q: "Court", status: "unread", category: "bookings", sort: "oldest", page: "2",
  }) }));
  expect(html).not.toContain(">Apply</button>");
  expect(html).toContain('name="q"');
  expect(html).toContain('value="Court"');
  expect(html).toContain('name="status"');
  expect(html).toContain('name="category"');
  expect(html).toContain('name="sort"');
  expect(html).not.toContain('name="page"');
  expect(html).toContain("q=Court&amp;status=unread&amp;category=bookings&amp;sort=oldest&amp;page=3");
  expect(html).toContain(`/messages/${messageId}?q=Court&amp;status=unread&amp;category=bookings&amp;sort=oldest&amp;page=2`);
  expect(html).toContain('href="/messages"');
});

test("repository applies owner, case-insensitive search, status and kind before sorted pagination and count", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/repositories/notifications.repository")>("@/lib/db/repositories/notifications.repository");
  const makeBuilder = () => {
    const builder = { where: vi.fn(), andWhere: vi.fn(), orderBy: vi.fn(), addOrderBy: vi.fn(),
      take: vi.fn(), skip: vi.fn(), getMany: vi.fn().mockResolvedValue([]), getCount: vi.fn().mockResolvedValue(0) };
    for (const key of ["where", "andWhere", "orderBy", "addOrderBy", "take", "skip"] as const)
      builder[key].mockReturnValue(builder);
    return builder;
  };
  const listBuilder = makeBuilder(), countBuilder = makeBuilder();
  const scopedManager = { getRepository: vi.fn().mockReturnValue({ createQueryBuilder: vi.fn()
    .mockReturnValueOnce(listBuilder).mockReturnValueOnce(countBuilder) }) };
  const query = parseInboxQuery({ q: "CoAcH", status: "unread", category: "coaching", sort: "subject_asc", page: "2" });
  await actual.listUserMessages(scopedManager as never, owner, query, 25, 25);
  await actual.countUserMessages(scopedManager as never, owner, query);
  for (const builder of [listBuilder, countBuilder]) {
    expect(builder.where).toHaveBeenCalledWith("message.userId = :userId AND message.deletedAt IS NULL", { userId: owner });
    expect(builder.andWhere).toHaveBeenCalledWith(expect.stringContaining("lower(message.subject)"), { search: "CoAcH" });
    expect(builder.andWhere).toHaveBeenCalledWith("message.readAt IS NULL");
    expect(builder.andWhere).toHaveBeenCalledWith("message.kind LIKE :kindPrefix", { kindPrefix: "coaching.%" });
  }
  expect(listBuilder.orderBy).toHaveBeenCalledWith("LOWER(message.subject)", "ASC");
  expect(listBuilder.addOrderBy).toHaveBeenCalledWith("message.id", "ASC");
  expect(listBuilder.take).toHaveBeenCalledWith(25);
  expect(listBuilder.skip).toHaveBeenCalledWith(25);
  expect(countBuilder.getCount).toHaveBeenCalledOnce();
});

test.each([["bookings", "booking.%"], ["coaching", "coaching.%"], ["payments", "financial.%"]] as const)(
  "%s category filters stored %s kinds", async (category, kindPrefix) => {
    const actual = await vi.importActual<typeof import("@/lib/db/repositories/notifications.repository")>("@/lib/db/repositories/notifications.repository");
    const builder = { where: vi.fn(), andWhere: vi.fn(), getCount: vi.fn().mockResolvedValue(0) };
    for (const key of ["where", "andWhere"] as const) builder[key].mockReturnValue(builder);
    const scopedManager = { getRepository: () => ({ createQueryBuilder: () => builder }) };
    await actual.countUserMessages(scopedManager as never, owner, parseInboxQuery({ category }));
    expect(builder.andWhere).toHaveBeenCalledWith("message.kind LIKE :kindPrefix", { kindPrefix });
  });

test.each([
  ["newest", "message.createdAt", "DESC"], ["oldest", "message.createdAt", "ASC"],
  ["subject_asc", "LOWER(message.subject)", "ASC"], ["subject_desc", "LOWER(message.subject)", "DESC"],
] as const)("%s ordering uses message ID as a stable tie-breaker", async (sort, field, direction) => {
  const actual = await vi.importActual<typeof import("@/lib/db/repositories/notifications.repository")>("@/lib/db/repositories/notifications.repository");
  const builder = { where: vi.fn(), andWhere: vi.fn(), orderBy: vi.fn(), addOrderBy: vi.fn(),
    take: vi.fn(), skip: vi.fn(), getMany: vi.fn().mockResolvedValue([]) };
  for (const key of ["where", "andWhere", "orderBy", "addOrderBy", "take", "skip"] as const)
    builder[key].mockReturnValue(builder);
  const scopedManager = { getRepository: () => ({ createQueryBuilder: () => builder }) };
  await actual.listUserMessages(scopedManager as never, owner, parseInboxQuery({ sort, status: "read", category: "club" }), 25, 0);
  expect(builder.orderBy).toHaveBeenCalledWith(field, direction);
  expect(builder.addOrderBy).toHaveBeenCalledWith("message.id", direction);
  expect(builder.andWhere).toHaveBeenCalledWith("message.readAt IS NOT NULL");
  expect(builder.andWhere).toHaveBeenCalledWith(expect.stringContaining("message.kind NOT LIKE 'booking.%'"));
});

test("only known internal notification links are rendered", () => {
  expect(safeMessageHref("/my-activity/bookings")).toBe("/my-activity/bookings");
  expect(safeMessageHref(`/my-activity/bookings?booking=${messageId}`)).toBe(`/my-activity/bookings?booking=${messageId}`);
  expect(safeMessageHref(`/my-activity/history?booking=${messageId}`)).toBe(`/my-activity/history?booking=${messageId}`);
  expect(safeMessageHref(`/coach/bookings/lessons/${messageId}`)).toBe(`/coach/bookings/lessons/${messageId}`);
  expect(safeMessageHref(`/my-activity/bookings?booking=${messageId}&next=//external.example`)).toBeNull();
  expect(safeMessageHref(`//external.example/${messageId}`)).toBeNull();
  expect(safeMessageHref("javascript:alert(1)")).toBeNull();
});


test.each(["payment", "refund", "booking"])("permits exact Admin %s transaction links only", (kind) => {
  const href = `/admin/payments/transactions/${kind}/${messageId}`;
  expect(safeMessageHref(href)).toBe(href);
  for (const unsafe of [href + "/", href + "?next=//evil.test", href + "#x", href + "%0a", href + "\n", href + "\r",
    href.replace(messageId, "------------------------------------"), href.replace(messageId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    href.replace(kind, kind.toUpperCase()), href.replace(kind, "unsupported"),
    "https://evil.test" + href, "/" + href, href.replace("/admin/", "/%61dmin/"),
    href.replace("/transactions/", "/transactions/../"), href + "\\evil.test"]) {
    expect(safeMessageHref(unsafe)).toBeNull();
  }
  expect(safeMessageHref(`/admin/bookings/${messageId}#financial-history`))
    .toBe(`/admin/bookings/${messageId}#financial-history`);
});
