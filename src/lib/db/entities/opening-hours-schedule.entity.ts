import "server-only";
import { Check, Column, Entity, Exclusion, ForeignKey, PrimaryGeneratedColumn, Unique } from "typeorm";

import { LocationEntity } from "./location.entity";

@Entity({ schema: "public", name: "opening_hours_schedules" })
@ForeignKey(() => LocationEntity, ["locationId"], ["id"], { name: "opening_hours_schedules_location_id_fkey", onDelete: "CASCADE" })
@Unique("opening_hours_schedules_location_identity", ["locationId", "id"])
@Check("opening_hours_schedules_dates", "ends_on IS NULL OR starts_on <= ends_on")
@Exclusion("opening_hours_schedules_no_overlap", "USING gist (location_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)")
export class OpeningHoursScheduleEntity {
  @PrimaryGeneratedColumn("uuid", { primaryKeyConstraintName: "opening_hours_schedules_pkey" })
  id!: string;
  @Column({ name: "location_id", type: "uuid" })
  locationId!: string;
  @Column({ name: "starts_on", type: "date" })
  startsOn!: string;
  @Column({ name: "ends_on", type: "date", nullable: true })
  endsOn!: string | null;
  @Column({ type: "integer", default: 1 })
  revision!: number;
}
