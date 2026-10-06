import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, writer } = vi.hoisted(() => ({ account: vi.fn(), writer: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/supabase/booking-writer", () => ({ createBookingWriter: writer }));
import { listAdminLocations } from "@/lib/admin/locations";
import { locationFieldsSchema } from "@/lib/admin/locations-validation";
import { cancellationNoticeMinutesSchema, defaultCustomerCancellationNoticeMinutes } from "@/lib/bookings/cancellation-policy";

test("location policy stores bounded whole elapsed minutes", () => {
  expect(defaultCustomerCancellationNoticeMinutes).toBe(1440);
  for (const value of [0, 60, 90, 120, 1440, 2880, 43200]) {
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
  created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z",
};
const locationFetch = vi.fn<typeof fetch>();
const policyFetch = vi.fn<typeof fetch>();
const client = createClient("http://localhost:54321", "user-key", {
  auth: { persistSession: false }, global: { fetch: locationFetch },
});

beforeEach(() => {
  account.mockReset(); writer.mockReset(); locationFetch.mockReset(); policyFetch.mockReset();
  account.mockResolvedValue({ state: "active", userId: location.id, email: "admin@example.test", roles: ["admin"] });
  locationFetch.mockResolvedValue(Response.json([location]));
  policyFetch.mockResolvedValue(Response.json([{ id: location.id, customer_cancellation_notice_minutes: 1440 }]));
  writer.mockReturnValue(createClient("http://localhost:54321", "server-key", {
    auth: { persistSession: false }, global: { fetch: policyFetch },
  }));
});

test.each([0, 90, 1440, 43200])("direct Admin read preserves policy value %s and the location result shape", async (minutes) => {
  policyFetch.mockResolvedValue(Response.json([{ id: location.id, customer_cancellation_notice_minutes: minutes }]));
  expect(await listAdminLocations(client)).toEqual([{ ...location, customer_cancellation_notice_minutes: minutes }]);
  expect(account).toHaveBeenCalledWith(client);
  const url = new URL(String(policyFetch.mock.calls[0][0]));
  expect(url.pathname).toBe("/rest/v1/locations");
  expect(url.searchParams.get("select")).toBe("id,customer_cancellation_notice_minutes");
  const locationUrl = new URL(String(locationFetch.mock.calls[0][0]));
  expect(locationUrl.searchParams.get("archived_at")).toBe("is.null");
  expect(locationUrl.searchParams.get("order")).toBe("display_order.asc,name.asc,id.asc");
});

test.each<CurrentAccount>([
  { state: "active", userId: location.id, email: "member@example.test", roles: [] },
  { state: "active", userId: location.id, email: "coach@example.test", roles: ["coach"] },
  { state: "suspended", userId: location.id, email: "admin@example.test", roles: ["admin"] },
  { state: "unauthenticated" }, { state: "missing-profile" }, { state: "load-error" },
])("requires an active Admin before either SELECT: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(listAdminLocations(client)).rejects.toThrow();
  expect(writer).not.toHaveBeenCalled();
  expect(locationFetch).not.toHaveBeenCalled();
  expect(policyFetch).not.toHaveBeenCalled();
});

test("keeps archived location filtering and composes policy values by location ID", async () => {
  locationFetch.mockResolvedValue(Response.json([{ ...location, archived_at: "2026-10-02T12:00:00Z" }]));
  policyFetch.mockResolvedValue(Response.json([
    { id: "c7000000-0000-4000-8000-000000000012", customer_cancellation_notice_minutes: 0 },
    { id: location.id, customer_cancellation_notice_minutes: 120 },
  ]));
  expect(await listAdminLocations(client, "archived")).toEqual([
    { ...location, archived_at: "2026-10-02T12:00:00Z", customer_cancellation_notice_minutes: 120 },
  ]);
  expect(new URL(String(locationFetch.mock.calls[0][0])).searchParams.get("archived_at")).toBe("not.is.null");
});

test.each([{ policies: [] }, { policies: [{ id: location.id, customer_cancellation_notice_minutes: 43201 }] }])(
  "rejects missing or invalid policy values without a default or fallback", async ({ policies }) => {
    policyFetch.mockResolvedValue(Response.json(policies));
    await expect(listAdminLocations(client)).rejects.toThrow("Unable to load locations.");
  },
);

test("returns a safe error when the direct policy SELECT fails", async () => {
  policyFetch.mockResolvedValue(Response.json({ code: "42501", message: "private database details" }, { status: 403 }));
  await expect(listAdminLocations(client)).rejects.toThrow("Unable to load locations.");
});
