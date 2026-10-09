import "server-only";

import { Check, Column, Entity, Exclusion, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from "typeorm";

import { CourtEntity } from "./court.entity";

@Entity({ schema: "public", name: "court_coverage_periods" })
@Check("court_coverage_dates_check", "starts_on <= ends_on AND isfinite(starts_on) AND isfinite(ends_on)")
@Exclusion("court_coverage_no_overlap", "USING gist (court_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)")
export class CourtCoveragePeriodEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "court_coverage_periods_pkey" })
  id!: string;

  @Column({ name: "court_id", type: "uuid" })
  courtId!: string;

  @Column({ name: "starts_on", type: "date" })
  startsOn!: string;

  @Column({ name: "ends_on", type: "date" })
  endsOn!: string;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @ManyToOne(() => CourtEntity, { nullable: false, onDelete: "NO ACTION" })
  @JoinColumn({ name: "court_id", referencedColumnName: "id", foreignKeyConstraintName: "court_coverage_periods_court_id_fkey" })
  court!: Relation<CourtEntity>;
}
