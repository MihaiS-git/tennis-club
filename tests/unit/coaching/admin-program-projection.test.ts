import { expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: vi.fn() }));

import { adminCoachingLocation, adminCoachingProgram } from "@/lib/coaching/admin";
import { locationCurrencies } from "@/lib/admin/locations-validation";

it.each(locationCurrencies)("projects the exact Admin location fields and preserves %s currency and active status", (currency) => {
  for (const isActive of [true, false]) {
    const row = { id: "l1", name: "Club", currency, isActive, addressLine1: null, createdAt: new Date() };
    expect(adminCoachingLocation(row)).toStrictEqual({ id: "l1", name: "Club", currency, is_active: isActive });
  }
});

it("projects a coaching program row onto the exact Admin representation", () => {
  const row = {
    id: "p1", name: "Group", description: "Weekly group", programType: "group" as const, durations: [60, 90],
    minParticipants: 2, maxParticipants: 6, courtRentalIncluded: true, isActive: false, createdAt: new Date(),
  };
  expect(adminCoachingProgram(row)).toStrictEqual({
    id: "p1", name: "Group", description: "Weekly group", program_type: "group", durations: [60, 90],
    min_participants: 2, max_participants: 6, court_rental_included: true, is_active: false,
  });
});

it("preserves absent participant bounds as null", () => {
  const projected = adminCoachingProgram({
    id: "p2", name: "Private", description: "", programType: "private", durations: [60],
    minParticipants: null, maxParticipants: null, courtRentalIncluded: false, isActive: true,
  });
  expect(projected).toMatchObject({ min_participants: null, max_participants: null, description: "" });
});
