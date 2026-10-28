import { assert, test, vi } from "vitest";

// /book and /messages render these modules on first load, so everything they
// import ships in the initial client JavaScript. The validation library and
// Stripe belong to the on-demand confirmation dialog and payment step.
function forbid(...modules: string[]) {
  for (const name of modules) vi.doMock(name, () => {
    throw new Error(`${name} must not be imported by the initial client bundle`);
  });
}

test("the booking calendar's static imports exclude validation and Stripe", async () => {
  vi.resetModules();
  forbid("zod", "@stripe/stripe-js", "@stripe/stripe-js/pure", "@stripe/react-stripe-js");

  const { BookingCalendar } = await import("../../src/app/book/booking-calendar");
  const { CoachingControls } = await import("../../src/app/book/coaching-controls");
  const { formatMoney } = await import("../../src/lib/pricing/currency");
  const { minuteToTime } = await import("../../src/lib/courts/local-time");

  assert.isFunction(BookingCalendar);
  assert.isFunction(CoachingControls);
  assert.match(formatMoney(12345, "RON"), /^RON\s123\.45$/);
  assert.equal(minuteToTime(1440), "24:00");
});

test("inbox URL parsing loads without the validation library", async () => {
  vi.resetModules();
  forbid("zod");

  const { parseInboxQuery } = await import("../../src/lib/notifications/inbox-query");

  assert.deepEqual(parseInboxQuery({ status: "unread", page: "2" }),
    { q: "", status: "unread", category: "all", sort: "newest", page: 2 });
});
