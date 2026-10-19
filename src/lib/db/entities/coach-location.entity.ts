import "server-only";

import { Entity, ForeignKey, PrimaryColumn } from "typeorm";

import { CoachProfileEntity } from "./coach-profile.entity";
import { LocationEntity } from "./location.entity";

@Entity({ schema: "public", name: "coach_locations" })
@ForeignKey(() => CoachProfileEntity, ["coachUserId"], ["userId"], { name: "coach_locations_coach_user_id_fkey", onDelete: "CASCADE" })
@ForeignKey(() => LocationEntity, ["locationId"], ["id"], { name: "coach_locations_location_id_fkey", onDelete: "RESTRICT" })
export class CoachLocationEntity {
  @PrimaryColumn({ name: "coach_user_id", type: "uuid", primaryKeyConstraintName: "coach_locations_pkey" })
  coachUserId!: string;

  @PrimaryColumn({ name: "location_id", type: "uuid", primaryKeyConstraintName: "coach_locations_pkey" })
  locationId!: string;
}
