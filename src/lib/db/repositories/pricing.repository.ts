import "server-only";

import { Brackets, In, type EntityManager } from "typeorm";
import { z } from "zod";
import type { OpeningHoursPricingPlan } from "@/lib/pricing/opening-hours-reconciliation";
import { CourtEntity } from "../entities/court.entity";
import { LocationEntity } from "../entities/location.entity";
import { LocationPricingRuleEntity } from "../entities/location-pricing-rule.entity";
import { PricingRuleSetEntity } from "../entities/pricing-rule-set.entity";
import type { PublicDayRead } from "./clubs.repository";

export async function listLocationPublicationPricing(manager: EntityManager, locationId: string) {
  return manager.getRepository(LocationPricingRuleEntity).find({
    where: { locationId }, select: { courtId: true, courtState: true, endsOn: true, startsOn: true, weekday: true, startsAtMinute: true, endsAtMinute: true },
  });
}

export async function locationHasPricingRules(manager: EntityManager, locationId: string) {
  return manager.getRepository(LocationPricingRuleEntity).existsBy({ locationId });
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

export async function listBookingEditDayPricing(manager: EntityManager, locationId: string, courtIds: string[], weekday: number, date: string) {
  if (!courtIds.length) return [];
  return manager.getRepository(LocationPricingRuleEntity).createQueryBuilder("pricing")
    .where("pricing.location_id = :locationId AND pricing.court_id IN (:...courtIds) AND pricing.weekday = :weekday", { locationId, courtIds, weekday })
    .andWhere("(pricing.starts_on IS NULL OR pricing.starts_on <= :date) AND (pricing.ends_on IS NULL OR pricing.ends_on >= :date)", { date })
    .orderBy("pricing.court_id", "ASC").addOrderBy("pricing.id", "ASC")
    .getMany();
}

export async function listPublicDayPricing(manager: EntityManager, days: readonly PublicDayRead[]): Promise<unknown> {
  const withCourts = days.filter((day) => day.courtIds.length);
  if (!withCourts.length) return [];
  const rows: unknown = await manager.getRepository(LocationPricingRuleEntity).createQueryBuilder("p")
    .select("to_jsonb(p)", "row")
    .innerJoin(CourtEntity, "c", "c.id = p.court_id AND c.is_active")
    .innerJoin(LocationEntity, "l", "l.id = c.location_id AND l.is_active AND l.archived_at IS NULL AND l.is_public")
    .where(new Brackets((query) => withCourts.forEach((day, index) => query.orWhere(
      `(l.id = :location${index} AND p.court_id IN (:...courts${index}) AND p.weekday = :weekday${index}
        AND (p.starts_on IS NULL OR p.starts_on <= :date${index}) AND (p.ends_on IS NULL OR p.ends_on >= :date${index}))`,
      { [`location${index}`]: day.locationId, [`courts${index}`]: [...day.courtIds], [`weekday${index}`]: day.weekday,
        [`date${index}`]: day.date }))))
    .getRawMany();
  return z.array(z.object({ row: z.unknown() })).parse(rows).map(({ row }) => row);
}

// Configuration fence and location lock must already be held by the service.
export async function applyOpeningHoursPricing(manager: EntityManager, locationId: string,
  plan: OpeningHoursPricingPlan, now: Date) {
  if (plan.deleteRuleIds.length) await manager.delete(LocationPricingRuleEntity, { locationId, id: In(plan.deleteRuleIds) });
  for (const id of plan.removeRuleSetIds) await deleteLocationRuleSet(manager, id, locationId);
  for (const ids of plan.moveRuleIds) {
    const ruleSetId = await insertRuleSet(manager, locationId);
    await manager.update(LocationPricingRuleEntity, { id: In(ids), locationId }, { ruleSetId });
  }
  for (const rows of plan.newRuleSets) {
    const ruleSetId = await insertRuleSet(manager, locationId);
    await insertPricingRules(manager, rows.map((row) => ({ ...row, locationId, ruleSetId, updatedAt: now })));
  }
}
