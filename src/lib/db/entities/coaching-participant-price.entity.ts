import "server-only";

import { Check, Column, Entity, ForeignKey, PrimaryGeneratedColumn, Unique } from "typeorm";
import type { LocationCurrency } from "@/lib/pricing/money";

import { CoachingProgramEntity } from "./coaching-program.entity";

// A club-configured informational rate per person per 60 minutes for one participant
// count of a club-organized (Group/Junior) program in one currency. There is no coach
// column: these rates are never overridden per coach, and they are not checkout prices.
@Entity({ schema: "public", name: "coaching_participant_prices" })
@ForeignKey(() => CoachingProgramEntity, ["programId"], ["id"], { name: "coaching_participant_prices_program_id_fkey", onDelete: "RESTRICT" })
@Unique("coaching_participant_prices_rate", ["programId", "participantCount", "currency"])
@Check("coaching_participant_prices_participants_check", "participant_count BETWEEN 1 AND 100")
@Check("coaching_participant_prices_amount_check", "amount_minor > 0")
@Check("coaching_participant_prices_currency_check", "currency IN ('EUR', 'USD', 'GBP', 'RON', 'CHF')")
export class CoachingParticipantPriceEntity {
  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "coaching_participant_prices_pkey" })
  id!: string;

  @Column({ name: "program_id", type: "uuid" })
  programId!: string;

  @Column({ name: "participant_count", type: "integer" })
  participantCount!: number;

  @Column({ name: "amount_minor", type: "integer" })
  amountMinor!: number;

  @Column({ name: "currency", type: "text" })
  currency!: LocationCurrency;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
