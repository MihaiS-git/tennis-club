import "server-only";

import { Check, Column, Entity, Exclusion, ForeignKey, PrimaryGeneratedColumn } from "typeorm";

import type { CoachAvailabilityExceptionKind } from "@/lib/coaching/availability-validation";
import { CoachLocationEntity } from "./coach-location.entity";
import { CoachProfileEntity } from "./coach-profile.entity";

// A date-specific override of the weekly schedule. "unavailable" is coach-wide
// (no location) for the whole day or an interval; "available" is a one-off
// interval at an assigned location (composite FK, skipped by MATCH SIMPLE for
// coach-wide rows). Exceptions on one date never overlap each other.
@Entity({ schema: "public", name: "coach_availability_exceptions" })
@ForeignKey(() => CoachProfileEntity, ["coachUserId"], ["userId"], { name: "coach_availability_exceptions_coach_user_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CoachLocationEntity, ["coachUserId", "locationId"], ["coachUserId", "locationId"], { name: "coach_availability_exceptions_coach_location_fkey", onDelete: "RESTRICT" })
@Check("coach_availability_exceptions_kind_check", "(kind = 'unavailable' AND location_id IS NULL) OR (kind = 'available' AND location_id IS NOT NULL AND start_minute IS NOT NULL)")
@Check("coach_availability_exceptions_minutes_check", "(start_minute IS NULL AND end_minute IS NULL) OR (start_minute IS NOT NULL AND end_minute IS NOT NULL AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute AND start_minute % 30 = 0 AND end_minute % 30 = 0)")
@Check("coach_availability_exceptions_note_check", "char_length(note) <= 200")
@Exclusion("coach_availability_exceptions_no_overlap", "USING gist (coach_user_id WITH =, exception_date WITH =, int4range(COALESCE(start_minute, 0), COALESCE(end_minute, 1440), '[)') WITH &&)")
export class CoachAvailabilityExceptionEntity {
  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "coach_availability_exceptions_pkey" })
  id!: string;

  @Column({ name: "coach_user_id", type: "uuid" })
  coachUserId!: string;

  @Column({ name: "exception_date", type: "date" })
  exceptionDate!: string;

  @Column({ name: "kind", type: "text" })
  kind!: CoachAvailabilityExceptionKind;

  @Column({ name: "location_id", type: "uuid", nullable: true })
  locationId!: string | null;

  @Column({ name: "start_minute", type: "integer", nullable: true })
  startMinute!: number | null;

  @Column({ name: "end_minute", type: "integer", nullable: true })
  endMinute!: number | null;

  @Column({ name: "note", type: "text", default: "" })
  note!: string;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
