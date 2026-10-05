import { expect, it, vi } from "vitest";

const { context, redirect, reservations, bookings, history } = vi.hoisted(() => ({ context: vi.fn(), redirect: vi.fn(() => { throw new Error("redirect"); }), reservations: vi.fn(), bookings: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/profile/profile", () => ({ profileContext: context }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/reservations/personal-service", () => ({ listPersonalReservations: reservations }));
vi.mock("@/lib/bookings/history-service", () => ({ listOwnCourtHistory: history }));
vi.mock("@/lib/bookings/personal-service", () => ({ listOwnUpcomingCustomerBookings: bookings }));

import { MyActivityContent } from "@/app/my-activity/page";
import { MyBookingsContent } from "@/app/my-activity/bookings/page";
import { PersonalActivity } from "@/app/my-activity/bookings/personal-activity";
import { BookingHistoryContent, parseHistoryPage } from "@/app/my-activity/bookings/history/page";

const account = { state: "active", userId: "owner", email: "owner@example.test", roles: [] as string[] };

it.each([MyActivityContent, MyBookingsContent])("requires authentication", async (page) => {
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  await expect(page()).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/login");
  redirect.mockClear();
});

it("requires authentication for booking history", async () => {
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  await expect(BookingHistoryContent({ searchParams: Promise.resolve({ page: "2" }) })).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/login");
  expect(history).not.toHaveBeenCalled();
  redirect.mockClear();
});

it("renders a compact overview linking to bookings without fetching reservations", async () => {
  context.mockResolvedValue({ account });
  reservations.mockClear();
  const content = await MyActivityContent();
  const main = content.props.children;
  expect(main.props.children[0].props.children).toBe("My activity");
  const section = main.props.children[2];
  expect(section.props.children[0].props.children).toBe("Bookings & reservations");
  expect(section.props.children[2].props.href).toBe("/my-activity/bookings");
  expect(reservations).not.toHaveBeenCalled();
});

it.each([
  [[], false], [["admin"], true], [["coach"], true],
])("passes only the current %j account to the bookings page", async (roles, staff) => {
  context.mockResolvedValue({ account: { ...account, roles } });
  reservations.mockResolvedValue({ upcoming: [] });
  bookings.mockResolvedValue([]);
  const content = await MyBookingsContent();
  const activity = content.props.children.props.children[2].props.children;
  expect(activity.type).toBe(PersonalActivity);
  expect(activity.props).toEqual({ staff, userId: "owner", initialActivity: { upcoming: [], bookings: [] }, initialError: "" });
  expect(content.props.children.props.children[3].props.children[2].props.href).toBe("/my-activity/bookings/history");
});

it("supplies fresh user-scoped activity on every server render", async () => {
  const client = {};
  context.mockResolvedValue({ account, client });
  reservations.mockResolvedValue({ upcoming: [] });
  bookings.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "new-booking" }]);
  const first = await MyBookingsContent();
  const second = await MyBookingsContent();
  expect(first.props.children.props.children[2].props.children.props.initialActivity.bookings).toEqual([]);
  expect(second.props.children.props.children[2].props.children.props.initialActivity.bookings).toEqual([{ id: "new-booking" }]);
  expect(reservations).toHaveBeenCalledWith(client);
  expect(bookings).toHaveBeenCalledWith(client);
});

it("preserves the safe inline retry error when the initial server read fails", async () => {
  context.mockResolvedValue({ account });
  reservations.mockRejectedValueOnce(new Error("Private database error"));
  const content = await MyBookingsContent();
  const activity = content.props.children.props.children[2].props.children;
  expect(activity.props.initialActivity).toBeNull();
  expect(activity.props.initialError).toBe("Unable to load your court activity. Try again.");
});

it.each([undefined, "", "bad", "0", "-2", "1.5", "1000001", ["2", "3"]])("normalizes invalid history page %j", (value) => {
  expect(parseHistoryPage(value)).toBe(1);
});

it("loads only the requested history page and gives a route back", async () => {
  context.mockResolvedValue({ client: {}, account });
  history.mockResolvedValue({ rows: [], hasNext: false, page: 2 });
  const content = await BookingHistoryContent({ searchParams: Promise.resolve({ page: "2" }) });
  expect(history).toHaveBeenCalledWith(2, {});
  expect(content.props.children.props.children[0].props.href).toBe("/my-activity/bookings");
  expect(content.props.children.props.children[1].props.children).toBe("Booking history");
});
