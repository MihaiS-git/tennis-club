import "server-only";

import { Check, Column, Entity, Exclusion, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from "typeorm";
import type { courtStates } from "@/lib/pricing/validation";

import { CourtEntity } from "./court.entity";
import { LocationEntity } from "./location.entity";
import { PricingRuleSetEntity } from "./pricing-rule-set.entity";

@Entity({ schema: "public", name: "location_pricing_rules" })
@Index("location_pricing_rule_set_idx", ["ruleSetId"])
@Check("location_pricing_dates_check", "(starts_on IS NULL OR isfinite(starts_on)) AND (ends_on IS NULL OR isfinite(ends_on)) AND (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)")
@Check("location_pricing_positive_interval", "starts_at_minute < ends_at_minute")
@Check("location_pricing_rules_court_state_check", "court_state = ANY (ARRAY['outdoor'::text, 'covered'::text, 'indoor'::text])")
@Check("location_pricing_rules_ends_at_minute_check", "ends_at_minute >= 1 AND ends_at_minute <= 1440")
@Check("location_pricing_rules_price_per_hour_minor_check", "price_per_hour_minor > 0")
@Check("location_pricing_rules_starts_at_minute_check", "starts_at_minute >= 0 AND starts_at_minute <= 1439")
@Check("location_pricing_rules_weekday_check", "weekday >= 0 AND weekday <= 6")
@Exclusion("location_pricing_no_overlap", "USING gist (court_id WITH =, court_state WITH =, weekday WITH =, daterange(starts_on, ends_on, '[]') WITH &&, int4range(starts_at_minute, ends_at_minute, '[)') WITH &&)")
export class LocationPricingRuleEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "location_pricing_rules_pkey" })
  id!: string;

  @Column({ name: "location_id", type: "uuid" })
  locationId!: string;

  @Column({ name: "rule_set_id", type: "uuid" })
  ruleSetId!: string;

  @Column({ name: "court_id", type: "uuid" })
  courtId!: string;

  @Column({ name: "court_state", type: "text" })
  courtState!: typeof courtStates[number];

  @Column({ name: "weekday", type: "integer" })
  weekday!: number;

  @Column({ name: "starts_at_minute", type: "integer" })
  startsAtMinute!: number;

  @Column({ name: "ends_at_minute", type: "integer" })
  endsAtMinute!: number;

  @Column({ name: "starts_on", type: "date", nullable: true })
  startsOn!: string | null;

  @Column({ name: "ends_on", type: "date", nullable: true })
  endsOn!: string | null;

  @Column({ name: "price_per_hour_minor", type: "integer" })
  pricePerHourMinor!: number;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @ManyToOne(() => LocationEntity, { nullable: false, onDelete: "NO ACTION" })
  @JoinColumn({ name: "location_id", referencedColumnName: "id", foreignKeyConstraintName: "location_pricing_rules_location_id_fkey" })
  location!: Relation<LocationEntity>;

  @ManyToOne(() => PricingRuleSetEntity, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn([
    { name: "rule_set_id", referencedColumnName: "id", foreignKeyConstraintName: "pricing_rule_set_fk" },
    { name: "location_id", referencedColumnName: "locationId", foreignKeyConstraintName: "pricing_rule_set_fk" },
  ])
  ruleSet!: Relation<PricingRuleSetEntity>;

  @ManyToOne(() => CourtEntity, { nullable: false, onDelete: "NO ACTION" })
  @JoinColumn({ name: "court_id", referencedColumnName: "id", foreignKeyConstraintName: "location_pricing_rules_court_id_fkey" })
  court!: Relation<CourtEntity>;
}
