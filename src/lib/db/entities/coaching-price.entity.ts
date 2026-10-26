import "server-only";

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from "typeorm";
import type { LocationCurrency } from "@/lib/pricing/money";

import { CoachProgramEntity } from "./coach-program.entity";
import { CoachingProgramDurationEntity } from "./coaching-program-duration.entity";

// A club-wide default (coach_user_id NULL) or one coach's override: the configured lesson
// price/person of one program duration and participant count in one currency, for every
// program type. Every price is configured independently; nothing is derived from another
// count or duration. Prices are not tied to locations: the booking
// location only selects the currency. An override requires the coach to offer the program
// (composite FK, skipped for club defaults by MATCH SIMPLE).
@Entity({ schema: "public", name: "coaching_prices" })
@ForeignKey(() => CoachingProgramDurationEntity, ["programId", "durationMinutes"], ["programId", "durationMinutes"], { name: "coaching_prices_duration_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CoachProgramEntity, ["coachUserId", "programId"], ["coachUserId", "programId"], { name: "coaching_prices_coach_program_fkey", onDelete: "RESTRICT" })
@Index("coaching_prices_club_default", ["programId", "durationMinutes", "participantCount", "currency"], { unique: true, where: "coach_user_id IS NULL" })
@Index("coaching_prices_coach_override", ["coachUserId", "programId", "durationMinutes", "participantCount", "currency"], { unique: true, where: "coach_user_id IS NOT NULL" })
@Check("coaching_prices_participants_check", "participant_count BETWEEN 1 AND 100")
@Check("coaching_prices_amount_check", "amount_minor > 0")
@Check("coaching_prices_currency_check", "currency IN ('EUR', 'USD', 'GBP', 'RON', 'CHF')")
export class CoachingPriceEntity {
  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "coaching_prices_pkey" })
  id!: string;

  @Column({ name: "program_id", type: "uuid" })
  programId!: string;

  @Column({ name: "duration_minutes", type: "integer" })
  durationMinutes!: number;

  @Column({ name: "participant_count", type: "integer" })
  participantCount!: number;

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
