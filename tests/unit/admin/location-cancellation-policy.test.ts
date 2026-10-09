import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, database, locations } = vi.hoisted(() => ({ account: vi.fn(), database: vi.fn(), locations: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: database }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ listAdminLocations: locations }));
import { listAdminLocations } from "@/lib/admin/locations";
import { locationFieldsSchema } from "@/lib/admin/locations-validation";
import { cancellationNoticeMinutesSchema, defaultCustomerCancellationNoticeMinutes } from "@/lib/bookings/cancellation-policy";

test("location policy stores bounded whole elapsed minutes", () => {
  expect(defaultCustomerCancellationNoticeMinutes).toBe(1440);
  for (const value of [0, 90, 43200]) {
    expect(cancellationNoticeMinutesSchema.parse(value)).toBe(value);
    expect(locationFieldsSchema.shape.customer_cancellation_notice_minutes.parse(value)).toBe(value);
  }
  for (const value of [-1, 43201, 1.5, NaN, Infinity, "120", null, undefined])
    expect(cancellationNoticeMinutesSchema.safeParse(value).success).toBe(false);
});

const location = {
  id: "c7000000-0000-4000-8000-000000000011", name: "Club", slug: "club",
  address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null,
  allow_pay_at_club: false, timezone: "Europe/Bucharest", currency: "RON",
  is_active: true, is_public: false, archived_at: null, display_order: 1,
  created_at: "2026-10-01T12:00:00.000Z", updated_at: "2026-10-01T12:00:00.000Z",
};
const row = {
  id: location.id, name: "Club", slug: "club", addressLine1: null, addressLine2: null,
  city: null, postalCode: null, countryCode: null, allowPayAtClub: false,
  timezone: location.timezone, currency: "RON", isActive: true, isPublic: false,
  archivedAt: null, displayOrder: 1, customerCancellationNoticeMinutes: 1440,
  createdAt: new Date(location.created_at), updatedAt: new Date(location.updated_at),
};
const manager = {};
const client = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });

beforeEach(() => {
  vi.clearAllMocks();
  account.mockResolvedValue({ state: "active", userId: location.id, email: "admin@example.test", roles: ["admin"] });
  database.mockResolvedValue({ manager });
  locations.mockResolvedValue([row]);
});

test.each<CurrentAccount>([
  { state: "active", userId: location.id, email: "coach@example.test", roles: ["coach"] },
  { state: "suspended", userId: location.id, email: "admin@example.test", roles: ["admin"] },
  { state: "unauthenticated" },
])("requires an active Admin before persistence: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(listAdminLocations(client)).rejects.toThrow();
  expect(database).not.toHaveBeenCalled();
  expect(locations).not.toHaveBeenCalled();
});
