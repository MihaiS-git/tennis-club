import "server-only";

import { z } from "zod";
import { courtEnvironments } from "@/lib/admin/courts-validation";
import { coverageDatesSchema, type CoverageDates } from "./coverage-validation";

export type CourtState = "indoor" | "outdoor" | "covered";

// Calendar dates are supplied explicitly; timezone/today policy belongs to callers.
export function getCourtStateForDate(
  environment: typeof courtEnvironments[number],
  periods: readonly CoverageDates[],
  date: string,
): CourtState {
  z.enum(courtEnvironments).parse(environment);
  z.iso.date().parse(date);
  const coverage = z.array(coverageDatesSchema).parse(periods.map(({ starts_on, ends_on }) => ({ starts_on, ends_on })));
  if (environment === "indoor") return "indoor";
  return coverage.some(({ starts_on, ends_on }) => starts_on <= date && date <= ends_on)
    ? "covered" : "outdoor";
}
