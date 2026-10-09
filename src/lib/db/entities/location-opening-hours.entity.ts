import "server-only";

import { Check, Column, Entity, Exclusion, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from "typeorm";

import { LocationEntity } from "./location.entity";

@Entity({ schema: "public", name: "location_opening_hours" })
@Check("location_opening_hours_closes_at_minute_check", "closes_at_minute >= 1 AND closes_at_minute <= 1440")
@Check("location_opening_hours_opens_at_minute_check", "opens_at_minute >= 0 AND opens_at_minute <= 1439")
@Check("location_opening_hours_positive_interval", "opens_at_minute < closes_at_minute")
@Check("location_opening_hours_weekday_check", "weekday >= 0 AND weekday <= 6")
@Exclusion("location_opening_hours_no_overlap", "USING gist (location_id WITH =, weekday WITH =, int4range(opens_at_minute, closes_at_minute, '[)') WITH &&)")
export class LocationOpeningHoursEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "location_opening_hours_pkey" })
  id!: string;

  @Column({ name: "location_id", type: "uuid" })
  locationId!: string;

  @Column({ name: "weekday", type: "integer" })
  weekday!: number;

  @Column({ name: "opens_at_minute", type: "integer" })
  opensAtMinute!: number;

  @Column({ name: "closes_at_minute", type: "integer" })
  closesAtMinute!: number;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @ManyToOne(() => LocationEntity, { nullable: false, onDelete: "NO ACTION" })
  @JoinColumn({ name: "location_id", referencedColumnName: "id", foreignKeyConstraintName: "location_opening_hours_location_id_fkey" })
  location!: Relation<LocationEntity>;
}
