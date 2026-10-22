import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, query } = vi.hoisted(() => ({ account: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
vi.mock("@/lib/db/repositories/payments.repository", () => ({ loadAdminTransactionContext: async () => ({ payments: [], refunds: [] }) }));
import { getReservationDay, readInternalOccupancy } from "@/lib/reservations/service";

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-15T09:00:00Z");
const date = "2026-10-15";
const location = { id: id(1), name: "Club", timezone: "UTC", courts: [{ id: id(2), name: "Court 1" }, { id: id(3), name: "Court 2" }] };
const client = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });
const row = { court_id: id(2), starts_at_minute: 600, ends_at_minute: 660, status: "active", hold_expires_at: null, capture_accepted: false };
const hours = { id: id(4), location_id: id(1), weekday: 3, opens_at_minute: 600, closes_at_minute: 840,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
let detailRows: unknown[] = [];
const common = { includes_coaching: false, coach_user_id: null, coach_name: null, coaching_program_name: null, coaching: null, location_name: null, court_name: null, location_timezone: null, court_id: id(2), booking_date: date, starts_at_minute: 600, ends_at_minute: 660,
  cancellation_notice_minutes: null, total_amount_minor: null, currency: null, payment_facts: [], creator_email: null, creator_phone: null, account_user_id: null, payment_method: null };
const direct = { ...common, kind: "reservation", id: id(5), reason: "Practice", created_by_user_id: id(6),
  creator_name: "Own Name", customer_name: null, customer_email: null, customer_phone: null };
const booking = { ...common, kind: "booking", id: id(7), starts_at_minute: 660, ends_at_minute: 720,
  reason: null, created_by_user_id: null, creator_name: null, customer_name: "Snapshot", customer_email: "snapshot@example.test",
  customer_phone: "123", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON", payment_method: "pay_at_club" };

beforeEach(() => {
  vi.clearAllMocks(); query.mockReset();
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["coach"] });
  query.mockImplementation(async (sql: string) => sql.includes(" AS kind") ? detailRows : sql.includes("location_opening_hours") ? [hours] : [row]);
  detailRows = [direct, booking];
});

test.each<CurrentAccount>([
  { state: "unauthenticated" },
  { state: "active", userId: id(6), email: "member@example.test", roles: [] },
  { state: "suspended", userId: id(6), email: "coach@example.test", roles: ["coach"] },
])("rejects non-staff before any read: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(getReservationDay(location, date, now, client)).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

test.each(["admin", "coach"])("authorizes %s before bounded exact-resource reads", async (role) => {
  account.mockResolvedValue({ state: "active", userId: id(6), roles: [role] });
  const result = await getReservationDay(location, date, now, client);
  expect(account).toHaveBeenCalledWith(client);
  expect(account.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
  const [sql, args] = query.mock.calls.find(([sql]) => sql.includes("court_reservations"))!;
  expect(args).toEqual([date, [id(2), id(3)], null, 0, 1000]);
  expect(sql).toContain("r.status IN ('active', 'held')");
  expect(sql).toContain("AND c.is_active"); expect(sql).toContain("l.archived_at IS NULL");
  expect(sql).toContain("ORDER BY r.court_id, r.starts_at_minute, r.id");
  expect(sql).not.toMatch(/UPDATE|DELETE|INSERT/);
  expect(result.occupancy).toEqual([{ court_id: id(2), starts_at_minute: 600, ends_at_minute: 660 }]);
  expect(result.courts[0].cells.slice(0, 2)).toEqual(["booked", "booked"]);
  expect(result.adminOccupancy).toHaveLength(2);
  expect(result.canManage).toBe(role === "admin");
  expect(result.actorUserId).toBe(id(6));
});

test("includes live held rows with microseconds, excludes equal/expired/null deadlines and never writes", async () => {
  query.mockResolvedValue([
    row,
    { ...row, status: "held", starts_at_minute: 660, ends_at_minute: 720, hold_expires_at: "2026-10-15T09:00:00.000001Z" },
    { ...row, status: "held", hold_expires_at: now.toISOString() },
    { ...row, status: "held", hold_expires_at: "2026-10-15T08:59:59Z" },
    { ...row, status: "held", hold_expires_at: null },
  ]);
  expect(await readInternalOccupancy({ courtIds: [id(2)] }, date, now)).toEqual([
    { court_id: id(2), starts_at_minute: 600, ends_at_minute: 660 },
    { court_id: id(2), starts_at_minute: 660, ends_at_minute: 720 },
  ]);
  expect(query.mock.calls.every(([sql]) => !/UPDATE|DELETE|INSERT/.test(sql))).toBe(true);
});

test("projects historical coaching terms in one staff details query for Admins", async () => {
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["admin"] });
  const coaching = { programId: id(10), coachUserId: id(11), locationId: id(1), participantCount: 2,
    durationMinutes: 60, source: "club", amountMinor: 6000, currency: "RON", courtRentalIncluded: false,
    courtRentalMinor: 3000, courtAmountMinor: 3000 };
  detailRows = [direct, { ...booking, includes_coaching: true, coach_name: "Historical coach",
    coaching_program_name: "Historical program", coaching, location_name: "Historical club", court_name: "Historical court", location_timezone: "UTC" }];
  const result = await getReservationDay(location, date, now, client);
  expect(result.adminOccupancy[1]).toMatchObject({ includes_coaching: true, coach_name: "Historical coach",
    coaching_program_name: "Historical program", coaching, total_amount_minor: 9000, currency: "RON" });
  const details = query.mock.calls.filter(([sql]) => sql.includes(" AS kind"));
  expect(details).toHaveLength(1);
  expect(details[0][0]).toContain("v.pricing_evidence->'coaching'");
  expect(details[0][0]).toContain("v.coach_name");
  expect(details[0][0]).not.toContain("coach_profiles");
  expect(details[0][0]).not.toContain("coaching_programs");
});

test("Coaches receive bare intervals for other bookings and only contact details for their own lessons", async () => {
  const coachId = id(6), otherCoachId = id(11);
  const lesson = (n: number, coachUserId: string, customer: string) => ({ ...booking, id: id(20 + n), starts_at_minute: 720 + n * 60, ends_at_minute: 780 + n * 60,
    includes_coaching: true, coach_user_id: coachUserId, coach_name: `Coach ${n}`, coaching_program_name: `Program ${n}`, account_user_id: id(40 + n),
    customer_name: customer, customer_email: `${customer}@example.test`, customer_phone: `+40 ${n}`, total_amount_minor: 7700, payment_method: "online",
    payment_facts: [{ id: id(50 + n), booking_id: id(20 + n), method: "online", provider: "stripe", provider_payment_id: "pi_secret", amount_minor: 7700,
      currency: "RON", status: "captured", expires_at: null, created_at: "2026-10-01T00:00:00Z" }],
    coaching: { programId: id(60), coachUserId, locationId: id(1), participantCount: 1, durationMinutes: 60, source: "club", amountMinor: 5500,
      currency: "RON", courtRentalIncluded: false, courtRentalMinor: 2200, courtAmountMinor: 2200 } });
  const ownBooking = { ...booking, id: id(9), starts_at_minute: 1200, ends_at_minute: 1260, account_user_id: coachId, customer_name: "Coach as customer" };
  detailRows = [direct, { ...booking, account_user_id: id(30) }, lesson(1, otherCoachId, "OtherLessonCustomer"), lesson(2, coachId, "OwnLessonCustomer"), ownBooking];
  const result = await getReservationDay(location, date, now, client);
  expect(result.canManage).toBe(false);
  const interval = (start: number) => ({ court_id: id(2), booking_date: date, starts_at_minute: start, ends_at_minute: start + 60 });
  expect(result.adminOccupancy).toEqual([
    expect.objectContaining({ kind: "reservation", id: id(5), creator_name: "Own Name" }),
    { kind: "occupied", id: `occupied:${id(2)}:660`, ...interval(660) },
    { kind: "occupied", id: `occupied:${id(2)}:780`, ...interval(780) },
    { kind: "lesson", id: id(22), ...interval(840), coach_user_id: coachId, coach_name: "Coach 2", coaching_program_name: "Program 2",
      customer_name: "OwnLessonCustomer", customer_email: "OwnLessonCustomer@example.test", customer_phone: "+40 2" },
    // The Coach's own customer booking keeps its self-service details.
    expect.objectContaining({ kind: "booking", id: id(9), customer_name: "Coach as customer", total_amount_minor: 9000 }),
  ]);
  // Nothing identifying or financial about unrelated customers, other Coaches' lessons or own lessons leaves the server.
  const serialized = JSON.stringify(result.adminOccupancy.slice(1, 4));
  for (const leaked of ["Snapshot", "snapshot@example.test", "OtherLessonCustomer", "Coach 1", "Program 1", id(7), id(21), id(30), id(41), id(42),
    "pay_at_club", "online", "stripe", "pi_secret", "captured", "7700", "5500", "9000", "RON", "payment", "total_amount_minor", "currency",
    "account_user_id", "coaching\":", "cancellation_notice_minutes"])
    expect(serialized).not.toContain(leaked);
});
