import { afterEach, expect, test, vi } from "vitest";
import { renderBookingEmail, type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { sendMail } from "@/lib/mail/brevo";
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ logger: { error: logError } }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); logError.mockClear(); });
const event: BookingEmailEvent = {
  recipient: "snapshot@example.test", event_kind: "admin_rescheduled", payload: {
    booking_id: "00000000-0000-4000-8000-000000000003", customer_name: "Ana", location_name: "Club",
    timezone: "Europe/Bucharest", court_name: "Court 2", booking_date: "2099-10-16",
    starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 9001, currency: "RON",
    previous: { booking_date: "2099-10-15", court_name: "Court 1", starts_at_minute: 660, ends_at_minute: 720 },
  },
};
test("renders snapshot recipient and old/new schedule without payment claims", () => {
  const message = renderBookingEmail(event);
  expect(message.to).toBe("snapshot@example.test");
  expect(message.text).toContain("administrator has rescheduled");
  expect(message.text).toContain("Previous: 2099-10-15, 11:00–12:00, Court 1");
  expect(message.text).toContain("New schedule: 2099-10-16, 10:00–11:00, Court 2");
  expect(message.text).toContain("Booking total: 90.01 RON");
  for (const kind of ["confirmed", "customer_cancelled", "admin_cancelled", "customer_rescheduled"] as const) {
    const rendered = renderBookingEmail({ ...event, event_kind: kind });
    expect(rendered.subject).toBe(kind === "confirmed" ? "Booking confirmed" : kind.endsWith("cancelled") ? "Booking cancelled" : "Booking rescheduled");
    expect(rendered.text).not.toMatch(/paid|refund|receipt/i);
  }
});
test("cancellation mail snapshots refund request without claiming completion", () => {
  const rendered = renderBookingEmail({ ...event, event_kind: "customer_cancelled",
    payload: { ...event.payload, refund_status: "requested" } });
  expect(rendered.text).toContain("Your full payment refund has been requested.");
  expect(rendered.text).not.toContain("has been refunded");
});

const message = { to: "customer@example.test", subject: "Booking confirmed", text: "Booking details" };
function configuredFetch() {
  vi.stubEnv("BREVO_API_KEY", "private-test-key");
  vi.stubEnv("BOOKING_MAIL_FROM", "bookings@example.test");
  const request = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", request);
  return request;
}
test("Brevo accepts the preserved text template with server credentials and a bounded request", async () => {
  const request = configuredFetch();
  await sendMail(message);
  const [url, options] = request.mock.calls[0];
  expect(url).toBe("https://api.brevo.com/v3/smtp/email");
  expect(options.headers["api-key"]).toBe("private-test-key");
  expect(JSON.parse(options.body)).toEqual({ sender: { email: "bookings@example.test" }, to: [{ email: message.to }], subject: message.subject, textContent: message.text });
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(logError).not.toHaveBeenCalled();
});
test("provider rejection logs only the HTTP status and resolves without retries", async () => {
  const request = configuredFetch().mockResolvedValue(new Response("sensitive provider body", { status: 400 }));
  await expect(sendMail(message)).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  expect(logError.mock.calls).toEqual([[{ event: "booking_email.provider_rejected", status: 400 }, "Brevo rejected booking email"]]);
});
test("timeout aborts the request and resolves without retries or transport details", async () => {
  const request = configuredFetch();
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  request.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("sensitive transport details")));
  }));
  const sending = sendMail(message);
  controller.abort();
  await expect(sending).resolves.toBeUndefined();
  expect(timeout).toHaveBeenCalledWith(10_000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(logError.mock.calls).toEqual([[{ event: "booking_email.delivery_failed" }, "Brevo request failed or timed out"]]);
});
test("missing configuration skips HTTP and reports required variables safely", async () => {
  const request = configuredFetch(); vi.stubEnv("BREVO_API_KEY", "");
  await expect(sendMail(message)).resolves.toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  expect(logError).toHaveBeenCalled();
});
