import { expect, it, vi } from "vitest";

const { context, redirect, upcoming, history } = vi.hoisted(() => ({
  context: vi.fn(), redirect: vi.fn(() => { throw new Error("redirect"); }), upcoming: vi.fn(), history: vi.fn(),
}));
vi.mock("@/lib/profile/profile", () => ({ profileContext: context }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/bookings/activity-service", () => ({ listOwnUpcomingActivity: upcoming, listOwnCourtActivity: history }));

import MyActivityPage from "@/app/my-activity/page";
import LegacyHistoryPage from "@/app/my-activity/bookings/history/page";
import { MyBookingsContent } from "@/app/my-activity/bookings/content";
import { PersonalActivity } from "@/app/my-activity/bookings/personal-activity";
import { BookingHistoryContent } from "@/app/my-activity/history/content";
import { activityHref, parseActivityQuery } from "@/lib/bookings/activity-query";

const account = { state: "active", userId: "owner", roles: [] as string[] };
const result = { rows: [], upcoming: [], bookings: [], ordered: [], hasNext: false, locations: [], courts: [] };

it("redirects the overview directly to bookings", () => {
  expect(() => MyActivityPage()).toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/my-activity/bookings");
});

it("redirects the retired History route and preserves its query", async () => {
  await expect(LegacyHistoryPage({ searchParams: Promise.resolve({ page: "2", type: "booking" }) })).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/my-activity/history?page=2&type=booking");
});

it.each(["upcoming", "history"] as const)("requires authentication for %s", async (scope) => {
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  const props = { searchParams: Promise.resolve({}) };
  await expect(scope === "upcoming" ? MyBookingsContent(props) : BookingHistoryContent(props)).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/login");
});

it.each([[[], false], [["admin"], true], [["coach"], true]])("passes the current %j account and URL context to Bookings", async (roles, staff) => {
  context.mockResolvedValue({ account: { ...account, roles }, client: {} });
  upcoming.mockResolvedValue(result);
  const params = { page: "2", type: "reservation", sort: "duration", direction: "desc" };
  const content = await MyBookingsContent({ searchParams: Promise.resolve(params) });
  const activity = content.props.children;
  expect(activity.type).toBe(PersonalActivity);
  const expectedParams = staff ? params : { ...params, type: "booking" };
  expect(activity.props).toEqual({ staff, userId: "owner", initialActivity: result, initialError: "", listQuery: expectedParams });
  expect(upcoming).toHaveBeenLastCalledWith(expectedParams, {});
});

it("supplies fresh user-scoped activity on every server render", async () => {
  context.mockResolvedValue({ account, client: {} });
  upcoming.mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, bookings: [{ id: "new" }] });
  const first = await MyBookingsContent();
  const second = await MyBookingsContent();
  expect(first.props.children.props.initialActivity.bookings).toEqual([]);
  expect(second.props.children.props.initialActivity.bookings).toEqual([{ id: "new" }]);
});

it("preserves the safe inline retry error on read failure", async () => {
  context.mockResolvedValue({ account });
  upcoming.mockRejectedValueOnce(new Error("Private database error"));
  const content = await MyBookingsContent();
  expect(content.props.children.props.initialActivity).toBeNull();
  expect(content.props.children.props.initialError).toBe("Unable to load your court activity. Try again.");
});

it.each([undefined, "", "bad", "0", "-2", "1.5", "1000001", ["2", "3"]])("normalizes invalid page %j", (page) => {
  expect(parseActivityQuery({ page }, "history").page).toBe(1);
});

it("normalizes invalid filters, sort and dates safely with scope defaults", () => {
  expect(parseActivityQuery({ type: "bad", status: "bad", location: "bad", court: "bad", from: "2026-02-30", sort: "bad", direction: "bad" }, "history"))
    .toEqual({ page: 1, type: "all", status: "all", location: undefined, court: undefined, from: undefined, to: undefined, sort: "datetime", direction: "desc" });
  expect(parseActivityQuery({ status: "cancelled", sort: "status", from: "2026-10-05", to: "2026-10-01" }, "upcoming"))
    .toMatchObject({ status: "all", sort: "datetime", direction: "asc", from: undefined, to: undefined });
});

it("preserves all filters and sort in pagination links", () => {
  const query = parseActivityQuery({ page: "2", type: "booking", status: "cancelled", sort: "duration", direction: "asc", from: "2026-10-01" }, "history");
  const params = new URL(activityHref("history", query, 3), "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ page: "3", type: "booking", status: "cancelled", sort: "duration", direction: "asc", from: "2026-10-01" });
});

it.each([[[], false], [["admin"], true], [["coach"], true]])("loads globally filtered History for %j through one read", async (roles, staff) => {
  context.mockResolvedValue({ client: {}, account: { ...account, roles } });
  history.mockResolvedValue(result);
  const params = { page: "2", type: "reservation", status: "completed", sort: "court" };
  const content = await BookingHistoryContent({ searchParams: Promise.resolve(params) });
  expect(history).toHaveBeenLastCalledWith("history", parseActivityQuery(params, "history", staff), {});
  expect(content.props.children[0].props.staff).toBe(staff);
  expect(content.props.children[1].props["aria-label"]).toBe("Booking history");
});

it.each(["reservation", "all", "staff-only", ["reservation", "booking"]])("ignores regular-user URL type %j without losing other query state", (type) => {
  const query = parseActivityQuery({ type, page: "3", status: "cancelled", sort: "duration", direction: "desc", from: "2026-10-01" }, "history", false);
  expect(query).toMatchObject({ type: "booking", page: 3, status: "cancelled", sort: "duration", direction: "desc", from: "2026-10-01" });
  expect(new URL(activityHref("history", query, 4), "http://localhost").searchParams.get("type")).toBe("booking");
});
