import "server-only";

import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, Unique, type Relation } from "typeorm";
import type { courtSurfaces, courtEnvironments } from "@/lib/admin/courts-validation";

import { LocationEntity } from "./location.entity";

@Entity({ schema: "public", name: "courts" })
@Unique("courts_location_id_slug_key", ["locationId", "slug"])
@Check("courts_environment_check", "environment = ANY (ARRAY['outdoor'::text, 'indoor'::text])")
@Check("courts_surface_check", "surface = ANY (ARRAY['clay'::text, 'hard'::text, 'grass'::text, 'carpet'::text])")
export class CourtEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "courts_pkey" })
  id!: string;

  @Column({ name: "location_id", type: "uuid" })
  locationId!: string;

  @Column({ name: "name", type: "text" })
  name!: string;

  @Column({ name: "slug", type: "text" })
  slug!: string;

  @Column({ name: "surface", type: "text" })
  surface!: typeof courtSurfaces[number];

  @Column({ name: "environment", type: "text" })
  environment!: typeof courtEnvironments[number];

  @Column({ name: "has_lighting", type: "boolean", default: false })
  hasLighting!: boolean;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @ManyToOne(() => LocationEntity, { nullable: false, onDelete: "NO ACTION" })
  @JoinColumn({ name: "location_id", referencedColumnName: "id", foreignKeyConstraintName: "courts_location_id_fkey" })
  location!: Relation<LocationEntity>;
}
