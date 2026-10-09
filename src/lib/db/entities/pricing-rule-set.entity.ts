import "server-only";

import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, Unique, type Relation } from "typeorm";

import { LocationEntity } from "./location.entity";

@Entity({ schema: "public", name: "pricing_rule_sets" })
// pricing_rule_set_fk depends on this composite target to enforce matching locations.
// Reassess at migration cutover only together with the dependent FK.
@Unique("pricing_rule_sets_id_location_id_key", ["id", "locationId"])
export class PricingRuleSetEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "pricing_rule_sets_pkey" })
  id!: string;

  @Column({ name: "location_id", type: "uuid" })
  locationId!: string;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @ManyToOne(() => LocationEntity, { nullable: false, onDelete: "NO ACTION" })
  @JoinColumn({ name: "location_id", referencedColumnName: "id", foreignKeyConstraintName: "pricing_rule_sets_location_id_fkey" })
  location!: Relation<LocationEntity>;
}
