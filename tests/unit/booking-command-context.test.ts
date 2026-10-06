import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mondayWeekday } from "@/lib/pricing/resolution";

const { bookingWriter, account } = vi.hoisted(() => ({ bookingWriter: vi.fn(), account: vi.fn() }));
vi.mock("@/lib/supabase/booking-writer", () => ({ createBookingWriter: bookingWriter }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
import { readBookingActor, readBookingContext } from "@/lib/bookings/persistence";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { runBookingReschedule } from "@/lib/bookings/reschedule";
import { processBookingRefund } from "@/lib/payments/refunds";

const id = "ca000000-0000-4000-8000-000000000001";
const reservationId = "ca000000-0000-4000-8000-000000000002";
const courtId = "ca000000-0000-4000-8000-000000000003";
const locationId = "ca000000-0000-4000-8000-000000000004";
const actorId = "ca000000-0000-4000-8000-000000000005";
const attemptId = "ca000000-0000-4000-8000-000000000006";
const refundId = "ca000000-0000-4000-8000-000000000007";
const updated = "2099-10-14T10:00:00.123456+00:00";
const date = "2099-10-15";
// Literal PostgreSQL jsonb text: preserve spacing, numeric scale and escaping.
const snapshotText = String.raw`{"a": "back\\slash", "b": "quote\"text", "n": 1.00, "é": "ț"}`;
const fingerprint = createHash("md5").update(snapshotText).digest("hex");
const snapshotCsv = `pgrst_scalar\n"${snapshotText.replace(/\\/g, "\\\\").replace(/"/g, '""')}"`;

function fixture() {
  const actor = { id: actorId, status: "active" };
  const roles: { role_code: "admin" | "coach" }[] = [];
  const booking = { id, reservation_id: reservationId, account_user_id: actorId, status: "confirmed", updated_at: updated,
    total_amount_minor: 5000, currency: "RON", cancellation_notice_minutes: 120,
    customer_name: "Customer", customer_email: "customer@example.test", customer_phone: "123", payment_method: "online" };
  const reservation = { id: reservationId, court_id: courtId, booking_date: date, starts_at_minute: 600,
    ends_at_minute: 660, status: "active", hold_expires_at: null, updated_at: updated };
  const court = { id: courtId, name: "Court", location_id: locationId, is_active: true, environment: "outdoor" };
  const location = { id: locationId, name: "Club", timezone: "Europe/Bucharest", currency: "RON", is_active: true,
    archived_at: null, is_public: true, customer_cancellation_notice_minutes: 120, allow_pay_at_club: true };
  const payment = { id: attemptId, booking_id: id, method: "online", provider: "stripe", provider_payment_id: "pi_original",
    amount_minor: 5000, currency: "RON", status: "succeeded", expires_at: null, created_at: updated };
  const refund = { id: refundId, booking_id: id, payment_attempt_id: attemptId, provider: "stripe", provider_payment_id: "pi_original",
    amount_minor: 5000, currency: "RON", status: "succeeded", provider_refund_id: "re_original",
    admin_lease_token: null, admin_lease_until: null, admin_lease_actor_id: null };
  const event = { provider: "stripe", event_id: "evt_late", attempt_id: attemptId, provider_payment_id: "pi_original",
    outcome: "succeeded", settlement_result: "expired", reconciliation_required: true, amount_minor: 5000,
    currency: "RON", resolved_at: null, resolved_by_user_id: null };
  const hours = [{ id: reservationId, location_id: locationId, weekday: mondayWeekday(date), opens_at_minute: 600,
    closes_at_minute: 900, created_at: updated, updated_at: updated }];
  const pricing = [{ id: reservationId, rule_set_id: reservationId, location_id: locationId, court_id: courtId,
    court_state: "outdoor", weekday: mondayWeekday(date), starts_at_minute: 600, ends_at_minute: 900,
    starts_on: null, ends_on: null, price_per_hour_minor: 5000, created_at: updated, updated_at: updated }];
  const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
    const url = new URL(String(request));
    const resource = url.pathname.split("/").at(-1);
    const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    switch (resource) {
      case "booking_configuration_revision": return response({ revision: 42 });
      case "booking_command_snapshot": return new Response(snapshotCsv, { headers: { "Content-Type": "text/csv" } });
      case "users": return response(actor);
      case "user_roles": return response([...roles].sort((a, b) => a.role_code.localeCompare(b.role_code)));
      case "bookings": return response(booking);
      case "court_reservations": return response(url.searchParams.has("booking_date") ? [] : reservation);
      case "courts": return response(url.searchParams.has("location_id") ? [court] : court);
      case "locations": return response(location);
      case "location_opening_hours": return response(hours);
      case "location_pricing_rules": return response(pricing);
      case "court_coverage_periods": return response([{ court_id: courtId, starts_on: "2099-11-01", ends_on: "2099-11-30" }]);
      case "payment_attempts": return response([payment]);
      case "payment_refunds": return response(refund);
      case "payment_provider_events": return response([event]);
      case "commit_booking_cancellation": return response({ outcome: "cancelled", refund_id: refundId });
      case "commit_booking_reschedule": return response(null);
      case "commit_refund_result": return response("succeeded");
      default: throw new Error(`Unexpected request ${resource} ${init?.method}`);
    }
  });
  const writer = createClient("http://localhost:54321", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
  });
  bookingWriter.mockReturnValue(writer);
  return { writer, fetch, actor, roles, booking, reservation, court, location, payment, refund, event };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2099-10-14T12:00:00Z"));
  account.mockResolvedValue({ state: "active", userId: actorId, roles: [] });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("reads actor facts and deterministically ordered roles through scoped SELECTs", async () => {
  const f = fixture();
  f.roles.push({ role_code: "coach" }, { role_code: "admin" });
  expect(await readBookingActor(actorId, f.writer)).toEqual({ id: actorId, status: "active", roles: ["admin", "coach"] });
  const urls = f.fetch.mock.calls.map(([request]) => new URL(String(request)));
  expect(urls.map((url) => url.pathname)).toEqual(["/rest/v1/users", "/rest/v1/user_roles"]);
  expect(urls[0].searchParams.get("select")).toBe("id,status");
  expect(urls[0].searchParams.get("id")).toBe(`eq.${actorId}`);
  expect(urls[1].searchParams.get("select")).toBe("role_code");
  expect(urls[1].searchParams.get("user_id")).toBe(`eq.${actorId}`);
  expect(urls[1].searchParams.get("order")).toBe("role_code.asc");
});

it("preserves suspended actor facts without filtering them out", async () => {
  const f = fixture();
  f.actor.status = "suspended";
  expect(await readBookingActor(actorId, f.writer)).toEqual({ id: actorId, status: "suspended", roles: [] });
  await expect(cancelBookingCommand(id, actorId, false, null, f.writer)).rejects.toThrow("Not authorized");
  expect(f.fetch.mock.calls.some(([request]) => String(request).includes("/rpc/commit_booking_cancellation"))).toBe(false);
});

it("rejects missing users and role read failures without submitting a command", async () => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(new Response("null"));
  await expect(readBookingActor(actorId, f.writer)).rejects.toThrow();
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify(f.actor)));
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: "42501", message: "private database detail" }), { status: 403 }));
  await expect(cancelBookingCommand(id, actorId, false, null, f.writer)).rejects.toThrow("Unable to read booking actor roles.");
  expect(f.fetch.mock.calls.some(([request]) => String(request).includes("/rpc/commit_booking_cancellation"))).toBe(false);
});

it("composes booking facts from SELECTs and preserves the PostgreSQL snapshot text fingerprint", async () => {
  const f = fixture();
  expect(await readBookingContext(id, f.writer)).toMatchObject({ revision: 42, fingerprint,
    booking: f.booking, reservation: f.reservation, court: f.court, location: f.location,
    courts: [f.court], payments: [f.payment], refund: f.refund, events: [f.event],
    starts_at_instant: "2099-10-15T07:00:00.000Z", now: "2099-10-14T12:00:00.000Z" });
  const urls = f.fetch.mock.calls.map(([request]) => new URL(String(request)));
  expect(urls.filter((url) => url.pathname.includes("/rpc/")).map((url) => url.pathname))
    .toEqual(["/rest/v1/rpc/booking_command_snapshot"]);
  expect(urls.slice(0, 3).map((url) => url.pathname.split("/").at(-1)))
    .toEqual(["booking_configuration_revision", "booking_command_snapshot", "bookings"]);
  expect(urls.find((url) => url.pathname.endsWith("payment_provider_events"))?.searchParams.get("attempt_id"))
    .toBe(`in.(${attemptId})`);
  expect(urls.find((url) => url.pathname.endsWith("court_coverage_periods"))?.searchParams.get("court_id"))
    .toBe(`in.(${courtId})`);
});

it("returns null for a missing snapshot and rejects fingerprint transport errors", async () => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(new Response('{"revision":42}'));
  f.fetch.mockResolvedValueOnce(new Response("pgrst_scalar\n"));
  expect(await readBookingContext(id, f.writer)).toBeNull();
  expect(f.fetch).toHaveBeenCalledTimes(2);
  f.fetch.mockResolvedValueOnce(new Response('{"revision":42}'));
  f.fetch.mockResolvedValueOnce(new Response("unexpected"));
  await expect(readBookingContext(id, f.writer)).rejects.toThrow("Invalid booking fingerprint response.");
});

function commandBody(fetch: ReturnType<typeof fixture>["fetch"], name: string): unknown {
  const call = fetch.mock.calls.find(([request]) => String(request).endsWith(`/rpc/${name}`));
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body));
}

it("cancels through the new context reader with the original payment refund and command fence", async () => {
  const f = fixture();
  // Cancellation needs no existing refund; use a null response for this SELECT.
  const transport = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((request, init) => String(request).includes("/payment_refunds?")
    ? Promise.resolve(new Response("null")) : transport(request, init));
  expect(await cancelBookingCommand(id, actorId, false, null, f.writer)).toEqual({ outcome: "cancelled", refund_id: refundId });
  expect(commandBody(f.fetch, "commit_booking_cancellation")).toMatchObject({ p_id: id, p_revision: 42, p_fingerprint: fingerprint,
    p_scope: "owner", p_actor: actorId, p_actor_expected: { id: actorId, status: "active", roles: [] }, p_deadline: "2099-10-15T05:00:00.000Z", p_inclusive: true,
    p_refund: { payment_attempt_id: attemptId, provider_payment_id: "pi_original", amount_minor: 5000, currency: "RON" } });
});

it("reschedules through the new context reader with price calculation and existing stale tokens", async () => {
  const f = fixture();
  expect(await runBookingReschedule({ id, expectedUpdatedAt: updated, expectedBookingUpdatedAt: updated,
    courtId, date, startMinute: 660, endMinute: 720, save: true, expectedTotal: 5000, priceAcknowledged: false },
  f.writer, actorId, "owner")).toEqual({ ok: true, totalAmountMinor: 5000 });
  expect(commandBody(f.fetch, "commit_booking_reschedule")).toMatchObject({ p_id: id, p_revision: 42, p_fingerprint: fingerprint,
    p_scope: "owner", p_actor: actorId, p_actor_expected: { id: actorId, status: "active", roles: [] }, p_total: 5000,
    p_schedule: { court_id: courtId, booking_date: date, starts_at_minute: 660, ends_at_minute: 720 } });
});

it("finishes Admin refund reconciliation using SELECT facts and the original fingerprint fence", async () => {
  const f = fixture();
  f.booking.status = "expired"; f.reservation.status = "released"; f.payment.status = "expired";
  expect(await processBookingRefund(refundId, f.writer, { token: reservationId, actorId, bookingId: id })).toBe("succeeded");
  expect(commandBody(f.fetch, "commit_refund_result")).toMatchObject({ p_id: id, p_revision: 42, p_fingerprint: fingerprint,
    p_refund_id: refundId, p_status: "succeeded", p_provider_refund_id: "re_original",
    p_events: [{ provider: "stripe", event_id: "evt_late" }] });
});
