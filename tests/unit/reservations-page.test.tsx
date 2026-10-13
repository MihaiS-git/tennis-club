import { afterEach, expect, it, vi } from "vitest";

const { loadDay, loadLocations, redirect } = vi.hoisted(() => ({ loadDay: vi.fn(), loadLocations: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/reservations/service", () => ({ getReservationDay: loadDay, listInternalLocations: loadLocations }));

vi.mock("next/navigation", () => ({ redirect }));
import LegacyReservationsPage from "@/app/reservations/page";
import LegacyPaymentsPage from "@/app/admin/payments/page";
import { ReservationContent } from "@/app/admin/reservations/reservation-content";

const eligible = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "Europe/Bucharest", courts: [] };

afterEach(() => vi.useRealTimers());

it("preserves explicit past and future dates and rejects malformed dates", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T22:30:00Z"));
  loadLocations.mockResolvedValue([eligible]);
  for (const date of ["2099-10-15", "2000-01-01"]) {
    const content = await ReservationContent({ searchParams: Promise.resolve({ location: eligible.id, date }) });
    expect(content.props.children[0].props.date).toBe(date);
    expect(content.props.children.at(-1).props.date).toBe(date);
    expect(content.props.children.at(-1).props.location).toBe(eligible);
  }
  for (const date of ["invalid", "2026-02-30"]) {
    const content = await ReservationContent({ searchParams: Promise.resolve({ date }) });
    expect(content.props.children[0].props.date).toBeNull();
    expect(content.props.children.at(-1).type).toBe("p");
  }
});

it.each([
  [LegacyReservationsPage, "/admin/reservations"],
  [LegacyPaymentsPage, "/admin/payments/transactions"],
] as const)("redirects legacy routes with every query value preserved", async (page, target) => {
  for (const params of [{}, { location: eligible.id, date: "2099-10-15", q: "A & B", status: ["due", "pending"], omitted: undefined }]) {
    await page({ searchParams: Promise.resolve(params) });
    const expected = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) expected.append(key, item);
    }
    expect(redirect).toHaveBeenLastCalledWith(`${target}${expected.size ? `?${expected}` : ""}`);
  }
});
