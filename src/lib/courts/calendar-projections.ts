import type { CourtCoveragePeriodEntity } from "@/lib/db/entities/court-coverage-period.entity";
import type { LocationPricingRuleEntity } from "@/lib/db/entities/location-pricing-rule.entity";
import type { PricingRule } from "@/lib/pricing/validation";
import type { CoveragePeriod } from "./coverage-validation";

export function toCalendarPricingRule(row: Pick<LocationPricingRuleEntity,
  "id" | "ruleSetId" | "locationId" | "courtId" | "courtState" | "weekday"
  | "startsAtMinute" | "endsAtMinute" | "startsOn" | "endsOn" | "pricePerHourMinor"
  | "createdAt" | "updatedAt"
>): PricingRule {
  return {
    id: row.id,
    rule_set_id: row.ruleSetId,
    location_id: row.locationId,
    court_id: row.courtId,
    court_state: row.courtState,
    weekday: row.weekday,
    starts_at_minute: row.startsAtMinute,
    ends_at_minute: row.endsAtMinute,
    starts_on: row.startsOn,
    ends_on: row.endsOn,
    price_per_hour_minor: row.pricePerHourMinor,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toCalendarCoveragePeriod(row: Pick<CourtCoveragePeriodEntity,
  "id" | "courtId" | "startsOn" | "endsOn" | "createdAt" | "updatedAt"
>): CoveragePeriod {
  return {
    id: row.id,
    court_id: row.courtId,
    starts_on: row.startsOn,
    ends_on: row.endsOn,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
