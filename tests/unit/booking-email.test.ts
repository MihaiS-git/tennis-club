import { expect, test, vi } from "vitest";
import { renderBookingEmail, type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { smtpFailure } from "@/lib/mail/smtp";
import { deliverNextBookingEmail } from "@/lib/notifications/worker";
import { createClient } from "@supabase/supabase-js";

const event: BookingEmailEvent = {
  id: "00000000-0000-4000-8000-000000000001", lease_token: "00000000-0000-4000-8000-000000000002",
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
  expect(message.idempotencyKey).toBe(event.id);
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
test("SMTP only retries definite non-delivery; ambiguous DATA failures are quarantined", () => {
  expect(smtpFailure({ command: "CONN", code: "ECONNREFUSED" }).outcome).toBe("retry");
  expect(smtpFailure({ command: "DATA", responseCode: 451 }).outcome).toBe("retry");
  expect(smtpFailure({ command: "DATA", responseCode: 550 }).outcome).toBe("failed");
  expect(smtpFailure({ command: "DATA", code: "ETIMEDOUT" }).outcome).toBe("uncertain");
  expect(smtpFailure(new Error("disconnected"))).toEqual({ outcome: "uncertain", error: "smtp_acknowledgement_unknown" });
});
test("worker checks lease before sending and records failures without leaking transport errors", async () => {
  const client = createClient("http://localhost:54321", "test");
  const rpc = vi.spyOn(client, "rpc");
  rpc.mockResolvedValueOnce({ data: [event], error: null, success: true, count: null, status: 200, statusText: "OK" });
  rpc.mockResolvedValueOnce({ data: false, error: null, success: true, count: null, status: 200, statusText: "OK" });
  const send = vi.fn();
  await deliverNextBookingEmail(client, { send });
  expect(send).not.toHaveBeenCalled();
  rpc.mockResolvedValueOnce({ data: [event], error: null, success: true, count: null, status: 200, statusText: "OK" });
  rpc.mockResolvedValueOnce({ data: true, error: null, success: true, count: null, status: 200, statusText: "OK" });
  rpc.mockResolvedValueOnce({ data: true, error: null, success: true, count: null, status: 200, statusText: "OK" });
  send.mockRejectedValueOnce(new Error("sensitive transport details"));
  await deliverNextBookingEmail(client, { send });
  expect(rpc).toHaveBeenLastCalledWith("finish_booking_email", {
    p_id: event.id, p_token: event.lease_token, p_outcome: "uncertain", p_error: "adapter_acknowledgement_unknown",
  });
});
