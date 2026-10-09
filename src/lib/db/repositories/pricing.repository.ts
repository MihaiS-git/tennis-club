import "server-only";

import { In, type EntityManager } from "typeorm";
import { z } from "zod";
import { CourtEntity } from "../entities/court.entity";
import { LocationPricingRuleEntity } from "../entities/location-pricing-rule.entity";
import { PricingRuleSetEntity } from "../entities/pricing-rule-set.entity";

export async function listLocationPublicationPricing(manager: EntityManager, locationId: string) {
  return manager.getRepository(LocationPricingRuleEntity).find({
    where: { locationId }, select: { courtId: true, courtState: true, endsOn: true },
  });
}

export async function listLocationHoursCompatibilityPricing(manager: EntityManager, locationId: string) {
  return manager.getRepository(LocationPricingRuleEntity).find({
    where: { locationId },
    select: { id: true, weekday: true, startsAtMinute: true, endsAtMinute: true, startsOn: true, endsOn: true },
    order: { weekday: "ASC", startsAtMinute: "ASC", endsAtMinute: "ASC", id: "ASC" },
  });
}

export async function listLocationPricingRules(manager: EntityManager, locationId: string) {
  return manager.getRepository(LocationPricingRuleEntity).find({ where: { locationId }, order: { id: "ASC" } });
}

export async function findPricingCourts(manager: EntityManager, locationId: string, courtIds: readonly string[]) {
  return manager.getRepository(CourtEntity).find({
    where: { locationId, id: In([...courtIds]) }, select: { id: true, locationId: true, environment: true },
  });
}

// Call only after configuration advisory and location aggregate locks.
export async function findLocationRuleSet(manager: EntityManager, id: string, locationId: string) {
  return manager.getRepository(PricingRuleSetEntity).findOne({
    where: { id, locationId }, lock: { mode: "pessimistic_write" },
  });
}

export async function insertRuleSet(manager: EntityManager, locationId: string): Promise<string> {
  const result = await manager.createQueryBuilder().insert().into(PricingRuleSetEntity)
    .values({ locationId }).returning("id").updateEntity(false).execute();
  return z.array(z.object({ id: z.uuid() })).length(1).parse(result.raw)[0].id;
}

export async function deleteRuleSetRules(manager: EntityManager, id: string, locationId: string) {
  await manager.getRepository(LocationPricingRuleEntity).delete({ ruleSetId: id, locationId });
}

export type PricingRuleFields = Pick<LocationPricingRuleEntity,
  "locationId" | "ruleSetId" | "courtId" | "courtState" | "weekday" | "startsAtMinute" | "endsAtMinute"
  | "startsOn" | "endsOn" | "pricePerHourMinor" | "updatedAt"
>;

export async function insertPricingRules(manager: EntityManager, rows: readonly PricingRuleFields[]) {
  await manager.createQueryBuilder().insert().into(LocationPricingRuleEntity)
    .values(rows.map((row) => ({ locationId: row.locationId, ruleSetId: row.ruleSetId, courtId: row.courtId,
      courtState: row.courtState, weekday: row.weekday, startsAtMinute: row.startsAtMinute, endsAtMinute: row.endsAtMinute,
      startsOn: row.startsOn, endsOn: row.endsOn, pricePerHourMinor: row.pricePerHourMinor, updatedAt: row.updatedAt })))
    .updateEntity(false).execute();
}

export async function deleteLocationRuleSet(manager: EntityManager, id: string, locationId: string): Promise<string | null> {
  const result = await manager.createQueryBuilder().delete().from(PricingRuleSetEntity)
    .where({ id, locationId }).returning("id").execute();
  return z.array(z.object({ id: z.uuid() })).max(1).parse(result.raw)[0]?.id ?? null;
}

export async function listCheckoutPricing(manager: EntityManager, courtId: string, weekday: number, date: string) {
  return manager.getRepository(LocationPricingRuleEntity).createQueryBuilder("pricing")
    .where("pricing.court_id = :courtId AND pricing.weekday = :weekday", { courtId, weekday })
    .andWhere("(pricing.starts_on IS NULL OR pricing.starts_on <= :date) AND (pricing.ends_on IS NULL OR pricing.ends_on >= :date)", { date })
    .getMany();
}

export async function listPublicDayPricing(manager: EntityManager, locationId: string, courtIds: string[], weekday: number, date: string): Promise<unknown> {
  const rows: unknown = await manager.query(`SELECT to_jsonb(p) AS row FROM public.location_pricing_rules p
    JOIN public.courts c ON c.id=p.court_id AND c.is_active
    JOIN public.locations l ON l.id=c.location_id AND l.is_active AND l.archived_at IS NULL AND l.is_public
    WHERE l.id=$1 AND p.court_id=ANY($2::uuid[]) AND p.weekday=$3
      AND (p.starts_on IS NULL OR p.starts_on<=$4::date)
      AND (p.ends_on IS NULL OR p.ends_on>=$4::date)`, [locationId,courtIds,weekday,date]);
  return z.array(z.object({ row: z.unknown() })).parse(rows).map(({ row }) => row);
}
