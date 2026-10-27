import { beforeEach, expect, it, vi } from "vitest";

const { context, redirect, upcoming, history, target } = vi.hoisted(() => ({
  context: vi.fn(), redirect: vi.fn((url: string) => { throw new Error(`redirect: ${url}`); }), upcoming: vi.fn<typeof import("@/lib/bookings/activity-service").listOwnUpcomingActivity>(), history: vi.fn(), target: vi.fn(),
}));
vi.mock("@/lib/profile/profile", () => ({ profileContext: context }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/bookings/activity-service", () => ({ listOwnUpcomingActivity: upcoming, listOwnCourtActivity: history,
  findOwnBookingActivityTarget: target }));

import { MyBookingsContent } from "@/app/my-activity/bookings/content";
import { BookingHistoryContent } from "@/app/my-activity/history/content";
import { parseActivityQuery } from "@/lib/bookings/activity-query";

const account = { state: "active", userId: "owner", roles: [] as string[] };
const result: import("@/lib/bookings/activity-service").UpcomingActivity = { upcoming: [], bookings: [], ordered: [], hasNext: false, locations: [], courts: [] };
const bookingId = "ae000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  target.mockResolvedValue(null);
});

it.each(["upcoming"] as const)("requires authentication for %s", async (scope) => {
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  const props = { searchParams: Promise.resolve({}) };
  await expect(scope === "upcoming" ? MyBookingsContent(props) : BookingHistoryContent(props)).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/login");
});

it("supplies fresh user-scoped activity on every server render", async () => {
  context.mockResolvedValue({ account, client: {} });
  target.mockResolvedValue(null);
  const nextResult = { ...result, hasNext: true };
  upcoming.mockResolvedValueOnce(result).mockResolvedValueOnce(nextResult);
  const first = await MyBookingsContent();
  const second = await MyBookingsContent();
  expect(first.props.children.props.initialActivity).toBe(result);
  expect(second.props.children.props.initialActivity).toBe(nextResult);
  expect(first.props.children.props.deepLinkedBooking).toBeNull();
  expect(target).toHaveBeenCalledWith(undefined, account.userId);
});

it("passes only an owner-resolved booking to the existing details dialog, independent of list filters", async () => {
  context.mockResolvedValue({ account, client: {} });
  const selected = { id: bookingId, court_name: "Owned court" };
  target.mockResolvedValueOnce({ scope: "upcoming", booking: selected }).mockResolvedValueOnce(null);
  upcoming.mockResolvedValue(result);
  const valid = await MyBookingsContent({ searchParams: Promise.resolve({ booking: bookingId, page: "3", type: "court" }) });
  expect(target).toHaveBeenCalledWith(bookingId, account.userId);
  expect(valid.props.children.props.deepLinkedBooking).toBe(selected);
  // The selected Type reaches the list unchanged; it is not overwritten for regular users.
  expect(valid.props.children.props.listQuery).toMatchObject({ page: "3", type: "court" });
  const denied = await MyBookingsContent({ searchParams: Promise.resolve({ booking: bookingId }) });
  expect(denied.props.children.props.deepLinkedBooking).toBeNull();
});

it("redirects an owned cancelled booking to History with its selection", async () => {
  context.mockResolvedValue({ account, client: {} });
  target.mockResolvedValue({ scope: "history", booking: { id: bookingId } });
  await expect(MyBookingsContent({ searchParams: Promise.resolve({ booking: bookingId, location: bookingId }) })).rejects.toThrow("redirect");
  expect(redirect.mock.lastCall![0]).toContain(`/my-activity/history?`);
  expect(redirect.mock.lastCall![0]).toContain(`booking=${bookingId}`);
  expect(redirect.mock.lastCall![0]).toContain(`location=${bookingId}`);
});

it("folds the regular-user booking type into All, but keeps it distinct for staff", () => {
  expect(parseActivityQuery({ type: "booking" }, "upcoming", false).type).toBe("all");
  expect(parseActivityQuery({ type: "reservation" }, "history", false).type).toBe("all");
  expect(parseActivityQuery({ type: "court" }, "upcoming", false).type).toBe("court");
  expect(parseActivityQuery({ type: "coaching" }, "history", false).type).toBe("coaching");
  expect(parseActivityQuery({ type: "booking" }, "upcoming", true).type).toBe("booking");
});

it("normalizes invalid filters, sort and dates safely with scope defaults", () => {
  expect(parseActivityQuery({ type: "bad", status: "bad", location: "bad", court: "bad", from: "2026-02-30", sort: "bad", direction: "bad" }, "history"))
    .toEqual({ page: 1, type: "all", status: "all", location: undefined, court: undefined, from: undefined, to: undefined, sort: "datetime", direction: "desc" });
  expect(parseActivityQuery({ status: "cancelled", sort: "status", from: "2026-10-05", to: "2026-10-01" }, "upcoming"))
    .toMatchObject({ status: "all", sort: "datetime", direction: "asc", from: undefined, to: undefined });
});
