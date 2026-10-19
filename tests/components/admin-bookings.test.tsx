// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: "", replace: vi.fn(), push: vi.fn(), authorize: vi.fn(), list: vi.fn(), options: vi.fn(),
  coaches: vi.fn(), records: vi.fn(), notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, push: mocks.push }), usePathname: () => "/admin/bookings",
  useSearchParams: () => new URLSearchParams(mocks.query), notFound: mocks.notFound }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/bookings/admin-details", () => ({ listAdminBookings: mocks.list, listAdminBookingFilterOptions: mocks.options,
  listAdminBookingCoachFilterOptions: mocks.coaches, getAdminBookingRecords: mocks.records }));

import AdminBookingsPage from "@/app/admin/bookings/page";
import AdminBookingPage from "@/app/admin/bookings/[bookingId]/page";
import { BookingsToolbar } from "@/app/admin/bookings/bookings-toolbar";

const central = "ac000000-0000-4000-8000-000000000001", archived = "ac000000-0000-4000-8000-000000000002";
const court = "ac000000-0000-4000-8000-000000000003", oldCourt = "ac000000-0000-4000-8000-000000000004";
const guestId = "ac000000-0000-4000-8000-0000000000a1", accountBookingId = "ac000000-0000-4000-8000-0000000000a2";
const userId = "ac000000-0000-4000-8000-0000000000f1";
const locations = [{ id: central, name: "Central", archived: false, courts: [{ id: court, name: "Court 1" }] },
  { id: archived, name: "Old club", archived: true, courts: [{ id: oldCourt, name: "Old court" }] }];
const booking = { includes_coaching: false, coach_name: null, coaching_program_name: null, id: guestId, status: "cancelled", created_at: "2024-12-20T09:30:00+00:00", account_user_id: null,
  booking_date: "2025-01-01", starts_at_minute: 600, ends_at_minute: 690, location_id: archived, location_name: "Old club",
  location_timezone: "UTC", court_id: oldCourt, court_name: "Old court", customer_name: "Guest Person", customer_email: "guest@example.test",
  total_amount_minor: 4550, currency: "RON" };
const details = { ...booking, coaching: null, customer_phone: "+40 700 000 000", cancellation_notice_minutes: 1440, payment_method: "online" };
const summary = { currency: "RON", total: 4550, paid: 0, refunded: 0, net: 0, pendingPayments: 0, pendingRefunds: 0, failedRefunds: 0,
  outstanding: 0, dueAtClub: 0, unrecordedAtClub: 0, activeBooking: false, otherCurrencies: [] };
const snapshot = { locationName: "Old club", courtName: "Old court", timezone: "UTC", date: "2025-01-01", startMinute: 600, endMinute: 690,
  total: 4550, currency: "RON" };
const created = { key: "r1", kind: "created", label: "Booking created", detail: "Booked by guest · Online payment", at: "2024-12-20T09:30:00.000Z",
  recorded: true, requestedAt: null, previous: null, next: snapshot, status: { label: "Confirmed", tone: "success" } };
const noOperations = { rows: [], page: 1, total: 0, totalPages: 1 };
const emptyRecords = { booking: details, history: [created], summary, operations: noOperations };
// The page reads the booking and its records together, from one snapshot.
const withBooking = (booking: object, records: object = {}) => mocks.records.mockResolvedValue({ ...emptyRecords, ...records, booking });

beforeEach(() => {
  vi.useFakeTimers(); mocks.query = ""; vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ roles: ["admin"] }); mocks.options.mockResolvedValue(locations);
  mocks.records.mockResolvedValue(emptyRecords);
  mocks.coaches.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const lastParams = () => Object.fromEntries(new URL(mocks.replace.mock.lastCall![0], "http://x").searchParams);

test("court filter is disabled until a location is selected and offers only that location's courts", () => {
  const { rerender } = render(<BookingsToolbar locations={locations} />);
  const courtSelect = screen.getByRole("combobox", { name: "Court" }) as HTMLSelectElement;
  expect(courtSelect.disabled).toBe(true);
  expect(within(screen.getByRole("combobox", { name: "Location" })).getByRole("option", { name: "Old club (archived)" })).toBeDefined();
  mocks.query = `location=${central}&court=${court}&status=cancelled&page=4`;
  rerender(<BookingsToolbar locations={locations} />);
  expect(within(courtSelect).getAllByRole("option").map((option) => option.textContent)).toEqual(["All", "Court 1"]);
  expect(courtSelect.value).toBe(court);
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: archived } });
  expect(lastParams()).toEqual({ location: archived, status: "cancelled" });
});

test("filters, dates and debounced search update the URL, keep header sorting and reset to page 1", () => {
  mocks.query = "status=confirmed&sort=scheduled&dir=asc&page=3";
  render(<BookingsToolbar locations={locations} />);
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
  expect(lastParams()).toEqual({ status: "confirmed", sort: "scheduled", dir: "asc", from: "2026-01-01" });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-31" } });
  expect(lastParams()).toEqual({ status: "confirmed", sort: "scheduled", dir: "asc", from: "2026-01-01", to: "2026-01-31" });
  expect(screen.queryByRole("combobox", { name: "Sort" })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: " ac000000 " } });
  expect(mocks.replace).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(350);
  expect(lastParams()).toMatchObject({ q: "ac000000" });
  expect(lastParams().page).toBeUndefined();
});

test("list renders guest and account bookings with links that preserve filters and page", async () => {
  mocks.list.mockResolvedValue({ rows: [booking, { ...booking, id: accountBookingId, account_user_id: userId, status: "pending_payment" }],
    page: 2, total: 22, totalPages: 2 });
  mocks.query = "";
  render(await AdminBookingsPage({ searchParams: Promise.resolve({ status: "cancelled", location: archived, court: oldCourt, page: "2" }) }));
  expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.list.mock.invocationCallOrder[0]);
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled", location: archived, court: oldCourt, page: 2 }));
  const table = within(screen.getByRole("table", { name: "Bookings" }));
  expect(table.getAllByText("Guest Person")).toHaveLength(2);
  expect(table.getAllByText("Guest")).toHaveLength(1);
  expect(table.getByText("Payment pending")).toBeDefined();
  expect(table.getAllByText("RON 45.50")).toHaveLength(2);
  const [link] = table.getAllByRole("link", { name: "#ac000000" });
  expect(link.getAttribute("href")).toBe(`/admin/bookings/${guestId}?status=cancelled&location=${archived}&court=${oldCourt}&page=2`);
  const sort = table.getByRole("link", { name: "Scheduled" });
  expect(sort.getAttribute("href")).toBe(`/admin/bookings?status=cancelled&location=${archived}&court=${oldCourt}&sort=scheduled`);
  expect(screen.getByRole("navigation", { name: "Pagination" })).toBeDefined();
  fireEvent.keyDown(table.getAllByRole("row")[1], { key: "Enter" });
  expect(mocks.push).toHaveBeenCalledWith(link.getAttribute("href"));
});

test("unknown locations and courts from another location are not queried", async () => {
  mocks.list.mockResolvedValue({ rows: [], page: 1, total: 0, totalPages: 1 });
  render(await AdminBookingsPage({ searchParams: Promise.resolve({ location: central, court: oldCourt }) }));
  expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ location: central, court: "" }));
  expect(screen.getByText("No bookings match these filters.")).toBeDefined();
  cleanup();
  render(await AdminBookingsPage({ searchParams: Promise.resolve({ location: "ac000000-0000-4000-8000-00000000dead" }) }));
  expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ location: "", court: "" }));
  expect(screen.getByText("No bookings yet.")).toBeDefined();
});

test("list authorization failure stops before reading", async () => {
  mocks.authorize.mockRejectedValueOnce(new Error("forbidden"));
  await expect(AdminBookingsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("forbidden");
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.options).not.toHaveBeenCalled();
});

test("guest details show stored contact facts, no account link, and a back link preserving list state", async () => {
  withBooking(details);
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }),
    searchParams: Promise.resolve({ q: "guest", status: "cancelled", page: "3", unknown: "x" }) }));
  expect(screen.getByText(guestId)).toBeDefined();
  expect(screen.getByRole("button", { name: "Copy ID" })).toBeDefined();
  expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
  expect(screen.getByText("Guest")).toBeDefined();
  expect(screen.getByText("+40 700 000 000")).toBeDefined();
  expect(screen.getByText("90 min")).toBeDefined();
  expect(screen.getByText("Online")).toBeDefined();
  expect(screen.queryByRole("link", { name: "View user account" })).toBeNull();
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/admin/bookings?q=guest&status=cancelled&page=3");
});

test("account details link to the authoritative account ID, not the contact email", async () => {
  withBooking({ ...details, id: accountBookingId, account_user_id: userId, status: "pending_payment", payment_method: "pay_at_club" });
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: accountBookingId }), searchParams: Promise.resolve({}) }));
  expect(mocks.records).toHaveBeenCalledWith(accountBookingId, { historyPage: 1 });
  expect(screen.getByRole("link", { name: "View user account" }).getAttribute("href")).toBe(`/admin/users/${userId}`);
  expect(screen.getByText("Account customer")).toBeDefined();
  expect(screen.getAllByText("Payment pending").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/admin/bookings");
});

test.each([
  ["/admin/payments/transactions?status=failed&q=Ana&page=4&sort=date&dir=desc", "Back to Transactions",
    "/admin/payments/transactions?status=failed&provider=all&method=all&attention=all&q=Ana&page=4&sort=date&dir=desc"],
  ["/admin/payments/notifications?q=guest&status=stopped&from=2026-01-01&page=2", "Back to Notifications",
    "/admin/payments/notifications?q=guest&status=stopped&from=2026-01-01&page=2"],
  [`/admin/payments/transactions/refund/${userId}?q=Ana&page=2`, "Back to Transaction",
    `/admin/payments/transactions/refund/${userId}?status=all&provider=all&method=all&attention=all&q=Ana&page=2&sort=date&dir=desc`],
])("opened from %s, Back returns to that exact Admin view and history paging keeps it", async (back, label, href) => {
  withBooking(details, { operations: { page: 1, total: 21, totalPages: 2, rows: [{ method: "online", provider: "stripe", currency: "RON",
    needsAttention: false, refunded_minor: 0, proposal: null, transaction_kind: "payment", operation_label: "Booking payment",
    amount_minor: 4550, transaction_status: "succeeded", created_at: "2024-12-20T09:30:00Z", transaction_id: userId }] } });
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }), searchParams: Promise.resolve({ back }) }));
  expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(href);
  const next = new URL(within(screen.getByRole("navigation", { name: "Financial history pages" }))
    .getByRole("link", { name: "Next" }).getAttribute("href")!, "http://x");
  expect([next.searchParams.get("back"), next.searchParams.get("history")]).toEqual([href, "2"]);
  expect(screen.queryByRole("link", { name: "Back to Bookings" })).toBeNull();
});

test.each(["https://evil.example/admin/payments/transactions", "//evil.example/admin/payments/notifications", "/admin/users",
  "/admin/payments/transactions/refund/not-a-uuid", "javascript:alert(1)"])("ignores unknown or external return target %s", async (back) => {
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }), searchParams: Promise.resolve({ back, status: "cancelled" }) }));
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/admin/bookings?status=cancelled");
});

test("invalid or missing booking IDs produce not found; authorization runs first", async () => {
  await expect(AdminBookingPage({ params: Promise.resolve({ bookingId: "ac000000" }), searchParams: Promise.resolve({}) })).rejects.toThrow("not found");
  expect(mocks.records).not.toHaveBeenCalled();
  mocks.records.mockResolvedValue(null);
  await expect(AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }), searchParams: Promise.resolve({}) })).rejects.toThrow("not found");
  mocks.authorize.mockRejectedValueOnce(new Error("forbidden")); mocks.records.mockClear();
  await expect(AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }), searchParams: Promise.resolve({}) })).rejects.toThrow("forbidden");
  expect(mocks.records).not.toHaveBeenCalled();
});

test("details render recorded history, verified financial summary and full-identity transaction links", async () => {
  const paymentId = "ac000000-0000-4000-8000-0000000000c1", refundId = "ac000000-0000-4000-8000-0000000000c2";
  const failedId = "ac000000-0000-4000-8000-0000000000c3";
  const operation = { method: "online", provider: "stripe", currency: "RON", needsAttention: false, refunded_minor: 0, proposal: null };
  mocks.records.mockResolvedValue({
    booking: { ...details, id: accountBookingId, account_user_id: userId, status: "confirmed", total_amount_minor: 5000 },
    history: [created, { ...created, key: "r2", kind: "change", label: "Extended", detail: "Changed by customer",
      at: "2024-12-21T10:00:00.000Z", previous: snapshot, next: { ...snapshot, endMinute: 720, total: 7500 } },
    { ...created, key: "r3", kind: "change", label: "Reduced", at: "2024-12-22T10:00:00.000Z",
      previous: { ...snapshot, endMinute: 720, total: 7500 }, next: { ...snapshot, total: 5000 } }],
    summary: { ...summary, total: 5000, paid: 7500, refunded: 2500, net: 5000, pendingRefunds: 300, activeBooking: true },
    operations: { page: 1, total: 3, totalPages: 1, rows: [
      { ...operation, transaction_kind: "payment", transaction_id: paymentId, operation_label: "Booking payment", amount_minor: 5000,
        transaction_status: "succeeded", created_at: "2024-12-20T09:31:00Z" },
      { ...operation, transaction_kind: "payment", transaction_id: failedId, operation_label: "Modification payment", amount_minor: 900,
        transaction_status: "failed", created_at: "2024-12-21T09:00:00Z" },
      { ...operation, transaction_kind: "refund", transaction_id: refundId, operation_label: "Price reduction refund", amount_minor: 2500,
        transaction_status: "pending_retry", needsAttention: true, created_at: "2024-12-22T10:00:01Z" },
    ] } });
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: accountBookingId }), searchParams: Promise.resolve({}) }));
  expect(mocks.records).toHaveBeenCalledWith(accountBookingId, { historyPage: 1 });
  expect(screen.queryByRole("navigation", { name: "Financial history pages" })).toBeNull();
  const history = within(screen.getByRole("region", { name: "Booking history" }));
  expect(history.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Booking createdConfirmed", "ExtendedConfirmed", "ReducedConfirmed"]);
  expect(history.getAllByText("Previous")).toHaveLength(2);
  expect(history.getAllByText("RON 75.00")).toHaveLength(2);
  expect(history.queryByText("No modifications or cancellations were recorded.")).toBeNull();
  const summaryRegion = within(screen.getByRole("region", { name: "Financial summary" }));
  expect(summaryRegion.getByText("Pending refunds")).toBeDefined();
  expect(summaryRegion.queryByText("Outstanding")).toBeNull();
  expect(summaryRegion.queryByText("Pending payments")).toBeNull();
  const table = within(screen.getByRole("table", { name: "Financial history" }));
  const fromBooking = `back=${encodeURIComponent(`/admin/bookings/${accountBookingId}`)}`;
  expect(table.getByRole("link", { name: "Booking payment" }).getAttribute("href")).toBe(`/admin/payments/transactions/payment/${paymentId}?${fromBooking}`);
  expect(table.getByRole("link", { name: "Price reduction refund" }).getAttribute("href")).toBe(`/admin/payments/transactions/refund/${refundId}?${fromBooking}`);
  expect(table.getByText("Paid")).toBeDefined(); expect(table.getByText("Failed")).toBeDefined();
  expect(table.getByText("Confirming with Stripe")).toBeDefined(); expect(table.getByText("Needs attention")).toBeDefined();
  expect(table.getByText("−RON 25.00")).toBeDefined();
  expect(screen.queryByText(/pi_|re_|idempotency/i)).toBeNull();
});

test("bookings without changes or payments stay understandable without empty financial tables", async () => {
  withBooking({ ...details, status: "confirmed", payment_method: "pay_at_club" }, { summary: { ...summary, activeBooking: true, dueAtClub: 4550 } });
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }), searchParams: Promise.resolve({}) }));
  expect(screen.getByText("No modifications or cancellations were recorded.")).toBeDefined();
  expect(screen.getByText("No payments or refunds were recorded for this booking.")).toBeDefined();
  expect(screen.queryByRole("table", { name: "Financial history" })).toBeNull();
  const summaryRegion = within(screen.getByRole("region", { name: "Financial summary" }));
  expect(summaryRegion.getByText("Due at club")).toBeDefined();
  expect(summaryRegion.getAllByText("RON 0.00")).toHaveLength(3);
});

test("long financial histories page on the server, keeping the booking list context and the full summary", async () => {
  const operation = { method: "online", provider: "stripe", currency: "RON", needsAttention: false, refunded_minor: 0, proposal: null,
    transaction_kind: "payment", operation_label: "Modification payment", amount_minor: 900, transaction_status: "failed",
    created_at: "2024-12-21T09:00:00Z" };
  withBooking({ ...details, status: "confirmed" }, { summary: { ...summary, paid: 4550, net: 4550 },
    operations: { page: 2, total: 1001, totalPages: 51, rows: Array.from({ length: 20 }, (_, index) =>
      ({ ...operation, transaction_id: `ac000000-0000-4000-8000-${String(500 + index).padStart(12, "0")}` })) } });
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }),
    searchParams: Promise.resolve({ status: "confirmed", page: "3", history: "2" }) }));
  expect(mocks.records).toHaveBeenCalledWith(guestId, { historyPage: 2 });
  expect(within(screen.getByRole("table", { name: "Financial history" })).getAllByRole("link")).toHaveLength(20);
  expect(screen.getByText(/1001 operations/)).toBeDefined();
  const pages = within(screen.getByRole("navigation", { name: "Financial history pages" }));
  expect(pages.getByRole("link", { name: "Next" }).getAttribute("href"))
    .toBe(`/admin/bookings/${guestId}?status=confirmed&page=3&history=3#financial-history`);
  expect(pages.getByRole("link", { name: "Previous" }).getAttribute("href"))
    .toBe(`/admin/bookings/${guestId}?status=confirmed&page=3#financial-history`);
  expect(pages.getByRole("link", { name: "51" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/admin/bookings?status=confirmed&page=3");
  expect(within(screen.getByRole("region", { name: "Financial summary" })).getAllByText("RON 45.50").length).toBeGreaterThan(1);
});


test("Type filters compose with search, sorting and existing filters, and reset pagination", () => {
  mocks.query = `q=Ana&status=confirmed&location=${central}&court=${court}&sort=scheduled&dir=asc&page=3&type=coaching`;
  render(<BookingsToolbar locations={locations} />);
  const type = screen.getByRole("combobox", { name: "Type" }) as HTMLSelectElement;
  expect([...type.options].map(option => option.textContent)).toEqual(["All", "Court", "Coaching"]);
  expect(type.value).toBe("coaching");
  fireEvent.change(type, { target: { value: "court" } });
  expect(lastParams()).toEqual({ q: "Ana", status: "confirmed", location: central, court, sort: "scheduled", dir: "asc", type: "court" });
  fireEvent.change(type, { target: { value: "all" } });
  expect(lastParams().type).toBeUndefined();
  expect(lastParams().q).toBe("Ana");
});

test("the Admin table and mobile cards share historical type details and preserve type in navigation", async () => {
  mocks.list.mockResolvedValue({ rows: [booking, { ...booking, id: accountBookingId, includes_coaching: true,
    coach_name: "Daniel Stoica", coaching_program_name: "Private coaching" }], page: 2, total: 21, totalPages: 2 });
  render(await AdminBookingsPage({ searchParams: Promise.resolve({ type: "coaching", q: "Ana", page: "2" }) }));
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ type: "coaching", q: "Ana", page: 2 }));
  const table = screen.getByRole("table", { name: "Bookings" });
  const cards = screen.getByRole("list", { name: "Bookings" });
  expect(within(table).getAllByRole("columnheader")).toHaveLength(8);
  expect(within(table).getByRole("columnheader", { name: "Type" })).toBeDefined();
  for (const view of [table, cards]) {
    expect(within(view).getByText("Coaching")).toBeDefined();
    expect(within(view).getByText("Court", { selector: "span" })).toBeDefined();
    expect(within(view).getByText("Daniel Stoica · Private coaching")).toBeDefined();
    expect(within(view).getAllByRole("link", { name: "#ac000000" })[1].getAttribute("href"))
      .toBe(`/admin/bookings/${accountBookingId}?q=Ana&type=coaching&page=2`);
  }
  const sort = new URL(within(table).getByRole("link", { name: "Scheduled" }).getAttribute("href")!, "http://x");
  expect(sort.searchParams.get("type")).toBe("coaching");
  expect(sort.searchParams.has("page")).toBe(false);
});

test.each([true, false])("Admin coaching details show stored names, participants, duration and fees (included=%s)", async (included) => {
  withBooking({ ...details, includes_coaching: true, coach_name: "Historical Coach", coaching_program_name: "Historical program",
    total_amount_minor: included ? 12000 : 18000, coaching: { participantCount: 2, durationMinutes: 90, amountMinor: 12000,
      currency: "RON", courtRentalIncluded: included, courtRentalMinor: 6000, courtAmountMinor: included ? 0 : 6000 } });
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }), searchParams: Promise.resolve({ type: "coaching", page: "2" }) }));
  const section = screen.getByRole("heading", { name: "Coaching" }).closest("section")!;
  for (const value of ["Historical Coach", "Historical program", "2", "90 min", "RON 120.00"])
    expect(within(section).getByText(value)).toBeDefined();
  expect(within(section).getByText(included ? "Included" : /Charged separately · RON 60.00/)).toBeDefined();
  const terms = screen.getByRole("heading", { name: "Booking terms" }).closest("section")!;
  expect(within(terms).getByText(included ? "RON 120.00" : "RON 180.00")).toBeDefined();
  expect(screen.getByText("Booking type").nextElementSibling?.textContent).toBe("Coaching");
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/admin/bookings?type=coaching&page=2");
});

test("older lessons explicitly show when participant count was not recorded", async () => {
  withBooking({ ...details, includes_coaching: true, coach_name: "Historical Coach", coaching_program_name: "Historical program",
    coaching: { durationMinutes: 60, amountMinor: 12000, currency: "RON", courtRentalIncluded: true, courtAmountMinor: 0 } });
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }), searchParams: Promise.resolve({}) }));
  expect(screen.getByText("Participants").nextElementSibling?.textContent).toBe("Not recorded");
});


const coaches = [{ id: userId, name: "Historical archived coach" }, { id: court, name: "Historical archived coach" }];

test.each(["", "type=court"])("hides Coach outside Coaching (%s)", (query) => {
  mocks.query = query;
  render(<BookingsToolbar locations={locations} coaches={coaches} />);
  expect(screen.queryByRole("combobox", { name: "Coach" })).toBeNull();
});

test("Coach uses distinct stored IDs even for matching historical names and resets page without dropping list state", () => {
  mocks.query = `type=coaching&coach=${userId}&q=Ana&status=cancelled&location=${central}&court=${court}&from=2026-01-01&to=2026-12-31&sort=scheduled&dir=asc&page=4`;
  render(<BookingsToolbar locations={locations} coaches={coaches} />);
  const select = screen.getByRole("combobox", { name: "Coach" }) as HTMLSelectElement;
  expect([...select.options].map(option => [option.textContent, option.value])).toEqual([
    ["All", ""], ["Historical archived coach", userId], ["Historical archived coach", court],
  ]);
  expect(select.value).toBe(userId);
  fireEvent.change(select, { target: { value: court } });
  expect(lastParams()).toEqual({ type: "coaching", coach: court, q: "Ana", status: "cancelled", location: central, court,
    from: "2026-01-01", to: "2026-12-31", sort: "scheduled", dir: "asc" });
  fireEvent.change(select, { target: { value: "" } });
  expect(lastParams().coach).toBeUndefined();
  expect(lastParams().type).toBe("coaching");
});

test.each(["court", "all"])("switching to %s clears Coach and resets pagination", (type) => {
  mocks.query = `type=coaching&coach=${userId}&status=confirmed&page=4&sort=scheduled&dir=asc`;
  render(<BookingsToolbar locations={locations} coaches={coaches} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: type } });
  expect(lastParams()).toEqual({ ...(type === "court" ? { type } : {}), status: "confirmed", sort: "scheduled", dir: "asc" });
});

test("coach filter survives list links, sorting, pagination and Back navigation", async () => {
  mocks.coaches.mockResolvedValue(coaches);
  mocks.query = `type=coaching&coach=${userId}&page=2`;
  mocks.list.mockResolvedValue({ rows: [booking], page: 2, total: 21, totalPages: 2 });
  render(await AdminBookingsPage({ searchParams: Promise.resolve({ type: "coaching", coach: userId, page: "2" }) }));
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ type: "coaching", coach: userId, page: 2 }));
  const table = within(screen.getByRole("table", { name: "Bookings" }));
  expect(table.getByRole("link", { name: "#ac000000" }).getAttribute("href"))
    .toBe(`/admin/bookings/${guestId}?type=coaching&coach=${userId}&page=2`);
  expect(new URL(table.getByRole("link", { name: "Scheduled" }).getAttribute("href")!, "http://x").searchParams.get("coach")).toBe(userId);
  const previous = within(screen.getByRole("navigation", { name: "Pagination" })).getByRole("link", { name: "Previous" });
  expect(new URL(previous.getAttribute("href")!, "http://x").searchParams.get("coach")).toBe(userId);
  cleanup();
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: guestId }),
    searchParams: Promise.resolve({ type: "coaching", coach: userId, page: "2" }) }));
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href"))
    .toBe(`/admin/bookings?type=coaching&coach=${userId}&page=2`);
});
