import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { readCheckoutContext } from "@/lib/bookings/persistence";

const courtId = "c9000000-0000-4000-8000-000000000011";
const locationId = "c9000000-0000-4000-8000-000000000012";
const court = { id: courtId, name: "Court", location_id: locationId, is_active: true, environment: "outdoor" };
const location = { id: locationId, name: "Club", timezone: "Europe/Bucharest", currency: "RON", is_active: true,
  archived_at: null, is_public: true, customer_cancellation_notice_minutes: 120, allow_pay_at_club: true };

function reader(responses: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(responses.shift()), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  const writer = createClient("http://localhost:54321", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
  });
  return { writer, fetch };
}

it("reads revision before court/location facts with scoped SELECTs and composes the start instant", async () => {
  const { writer, fetch } = reader([{ revision: 42 }, court, location]);
  expect(await readCheckoutContext(courtId, "2099-10-15", 600, writer)).toEqual({
    revision: 42, court, location, starts_at_instant: "2099-10-15T07:00:00.000Z",
  });
  const urls = fetch.mock.calls.map(([request]) => new URL(String(request)));
  expect(urls.map((url) => url.pathname)).toEqual([
    "/rest/v1/booking_configuration_revision", "/rest/v1/courts", "/rest/v1/locations",
  ]);
  expect(urls.map((url) => url.searchParams.get("select"))).toEqual([
    "revision", "id,name,location_id,is_active,environment",
    "id,name,timezone,currency,is_active,archived_at,is_public,customer_cancellation_notice_minutes,allow_pay_at_club",
  ]);
  expect(urls.map((url) => url.searchParams.get("id"))).toEqual(["eq.true", `eq.${courtId}`, `eq.${locationId}`]);
});

it("returns no context when the requested court does not exist", async () => {
  const { writer, fetch } = reader([{ revision: 42 }, []]);
  expect(await readCheckoutContext(courtId, "2099-10-15", 600, writer)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects failed configuration reads before reading resource facts", async () => {
  const { writer, fetch } = reader([null]);
  await expect(readCheckoutContext(courtId, "2099-10-15", 600, writer)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  ["2026-01-15", 600, "2026-01-15T08:00:00.000Z"],
  ["2026-07-15", 600, "2026-07-15T07:00:00.000Z"],
  ["2026-10-25", 210, "2026-10-25T01:30:00.000Z"],
  ["2026-03-29", 210, "2026-03-29T01:30:00.000Z"],
])("resolves checkout start for %s including timezone clock changes", async (date, minute, expected) => {
  const { writer } = reader([{ revision: 42 }, court, location]);
  expect((await readCheckoutContext(courtId, date, minute, writer))?.starts_at_instant).toBe(expected);
});
