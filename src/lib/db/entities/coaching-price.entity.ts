import "server-only";

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from "typeorm";
import type { LocationCurrency } from "@/lib/pricing/money";

import { CoachLocationEntity } from "./coach-location.entity";
import { CoachProgramEntity } from "./coach-program.entity";
import { CoachingProgramDurationEntity } from "./coaching-program-duration.entity";
import { LocationEntity } from "./location.entity";

// A club default (coach_user_id NULL) or one coach's override for a program
// duration at a location. Overrides require the coach to offer the program at
// that location (composite FKs, skipped for club defaults by MATCH SIMPLE).
// The entered currency is kept; resolution never re-denominates it.
@Entity({ schema: "public", name: "coaching_prices" })
@ForeignKey(() => CoachingProgramDurationEntity, ["programId", "durationMinutes"], ["programId", "durationMinutes"], { name: "coaching_prices_duration_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => LocationEntity, ["locationId"], ["id"], { name: "coaching_prices_location_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CoachProgramEntity, ["coachUserId", "programId"], ["coachUserId", "programId"], { name: "coaching_prices_coach_program_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CoachLocationEntity, ["coachUserId", "locationId"], ["coachUserId", "locationId"], { name: "coaching_prices_coach_location_fkey", onDelete: "RESTRICT" })
@Index("coaching_prices_club_default", ["programId", "durationMinutes", "locationId"], { unique: true, where: "coach_user_id IS NULL" })
@Index("coaching_prices_coach_override", ["programId", "durationMinutes", "locationId", "coachUserId"], { unique: true, where: "coach_user_id IS NOT NULL" })
@Check("coaching_prices_amount_check", "amount_minor > 0")
@Check("coaching_prices_currency_check", "currency IN ('EUR', 'USD', 'GBP', 'RON', 'CHF')")
export class CoachingPriceEntity {
  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "coaching_prices_pkey" })
  id!: string;

  @Column({ name: "program_id", type: "uuid" })
  programId!: string;

  @Column({ name: "duration_minutes", type: "integer" })
  durationMinutes!: number;

  @Column({ name: "location_id", type: "uuid" })
  locationId!: string;

  @Column({ name: "coach_user_id", type: "uuid", nullable: true })
  coachUserId!: string | null;

  @Column({ name: "amount_minor", type: "integer" })
  amountMinor!: number;

  @Column({ name: "currency", type: "text" })
  currency!: LocationCurrency;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
