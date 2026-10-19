import "server-only";

import { Check, Column, Entity, Exclusion, ForeignKey, PrimaryGeneratedColumn } from "typeorm";

import { CoachLocationEntity } from "./coach-location.entity";

// A coach's regular working interval on a Monday-first weekday, in the local
// wall time of its location. The composite FK requires the coach to be assigned
// to that location; one coach cannot work overlapping intervals anywhere.
// Availability alone never makes a lesson bookable.
@Entity({ schema: "public", name: "coach_weekly_availability" })
@ForeignKey(() => CoachLocationEntity, ["coachUserId", "locationId"], ["coachUserId", "locationId"], { name: "coach_weekly_availability_coach_location_fkey", onDelete: "RESTRICT" })
@Check("coach_weekly_availability_weekday_check", "weekday BETWEEN 0 AND 6")
@Check("coach_weekly_availability_minutes_check", "start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute AND start_minute % 30 = 0 AND end_minute % 30 = 0")
@Exclusion("coach_weekly_availability_no_overlap", "USING gist (coach_user_id WITH =, weekday WITH =, int4range(start_minute, end_minute, '[)') WITH &&)")
export class CoachWeeklyAvailabilityEntity {
  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "coach_weekly_availability_pkey" })
  id!: string;

  @Column({ name: "coach_user_id", type: "uuid" })
  coachUserId!: string;

  @Column({ name: "location_id", type: "uuid" })
  locationId!: string;

  @Column({ name: "weekday", type: "integer" })
  weekday!: number;

  @Column({ name: "start_minute", type: "integer" })
  startMinute!: number;

  @Column({ name: "end_minute", type: "integer" })
  endMinute!: number;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
