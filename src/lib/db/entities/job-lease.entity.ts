import "server-only";

import { Check, Column, Entity, PrimaryColumn } from "typeorm";

// One row per scheduled job. The lease fences overlapping runs across processes;
// it carries no business state and an expired lease may be taken over.
@Entity({ schema: "public", name: "job_leases" })
@Check("job_leases_name_check", "name ~ '^[a-z][a-z0-9_]*$'")
@Check("job_leases_lease_check", "(lease_token IS NULL) = (lease_until IS NULL) AND (lease_until IS NULL OR isfinite(lease_until))")
export class JobLeaseEntity {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "job_leases_pkey" }) name!: string;
  @Column({ name: "lease_token", type: "uuid", nullable: true }) leaseToken!: string | null;
  @Column({ name: "lease_until", type: "timestamptz", nullable: true }) leaseUntil!: Date | null;
  @Column({ name: "last_started_at", type: "timestamptz", nullable: true }) lastStartedAt!: Date | null;
  @Column({ name: "last_completed_at", type: "timestamptz", nullable: true }) lastCompletedAt!: Date | null;
}
