import { expect, it, vi } from "vitest";

const { context, redirect, upcoming, history } = vi.hoisted(() => ({
  context: vi.fn(), redirect: vi.fn(() => { throw new Error("redirect"); }), upcoming: vi.fn(), history: vi.fn(),
}));
vi.mock("@/lib/profile/profile", () => ({ profileContext: context }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/bookings/activity-service", () => ({ listOwnUpcomingActivity: upcoming, listOwnCourtActivity: history }));

import { MyBookingsContent } from "@/app/my-activity/bookings/content";
import { BookingHistoryContent } from "@/app/my-activity/history/content";
import { parseActivityQuery } from "@/lib/bookings/activity-query";

const account = { state: "active", userId: "owner", roles: [] as string[] };
const result = { rows: [], upcoming: [], bookings: [], ordered: [], hasNext: false, locations: [], courts: [] };

it.each(["upcoming"] as const)("requires authentication for %s", async (scope) => {
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  const props = { searchParams: Promise.resolve({}) };
  await expect(scope === "upcoming" ? MyBookingsContent(props) : BookingHistoryContent(props)).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/login");
});

it("supplies fresh user-scoped activity on every server render", async () => {
  context.mockResolvedValue({ account, client: {} });
  upcoming.mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, bookings: [{ id: "new" }] });
  const first = await MyBookingsContent();
  const second = await MyBookingsContent();
  expect(first.props.children.props.initialActivity.bookings).toEqual([]);
  expect(second.props.children.props.initialActivity.bookings).toEqual([{ id: "new" }]);
});

it("normalizes invalid filters, sort and dates safely with scope defaults", () => {
  expect(parseActivityQuery({ type: "bad", status: "bad", location: "bad", court: "bad", from: "2026-02-30", sort: "bad", direction: "bad" }, "history"))
    .toEqual({ page: 1, type: "all", status: "all", location: undefined, court: undefined, from: undefined, to: undefined, sort: "datetime", direction: "desc" });
  expect(parseActivityQuery({ status: "cancelled", sort: "status", from: "2026-10-05", to: "2026-10-01" }, "upcoming"))
    .toMatchObject({ status: "all", sort: "datetime", direction: "asc", from: undefined, to: undefined });
});
