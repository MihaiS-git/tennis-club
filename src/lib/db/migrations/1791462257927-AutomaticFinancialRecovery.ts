import type { MigrationInterface, QueryRunner } from "typeorm";

// Durable automatic recovery. Booking modifications that depend on a refund
// (cancellation, price reduction) are pending booking_adjustments until verified
// provider evidence decides them. A definitively failed obligation of an abandoned
// change is voided (no money moved; it no longer reserves captured funds).
// job_leases fences overlapping scheduler runs across application instances.
export class AutomaticFinancialRecovery1791462257927 implements MigrationInterface {
  name = "AutomaticFinancialRecovery1791462257927";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "booking_adjustments" ADD "kind" text NOT NULL DEFAULT 'reschedule'`);
    await queryRunner.query(`ALTER TABLE "booking_adjustments" ADD CONSTRAINT "booking_adjustments_kind_check" CHECK (kind IN ('reschedule', 'cancellation'))`);
    await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_status_check"`);
    await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'pending_retry'::text, 'succeeded'::text, 'failed'::text, 'voided'::text])))`);
    await queryRunner.query(`CREATE INDEX "payment_refunds_unresolved_idx" ON "payment_refunds" ("updated_at") WHERE status IN ('pending', 'pending_retry')`);
    await queryRunner.query(`CREATE TABLE "job_leases" ("name" text NOT NULL, "lease_token" uuid, "lease_until" TIMESTAMP WITH TIME ZONE, "last_started_at" TIMESTAMP WITH TIME ZONE, "last_completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "job_leases_name_check" CHECK (name ~ '^[a-z][a-z0-9_]*$'), CONSTRAINT "job_leases_lease_check" CHECK ((lease_token IS NULL) = (lease_until IS NULL) AND (lease_until IS NULL OR isfinite(lease_until))), CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name"))`);
    await queryRunner.query(`REVOKE ALL ON TABLE public.job_leases FROM PUBLIC, anon, authenticated`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.payment_refunds WHERE status='voided')
      OR EXISTS (SELECT 1 FROM public.booking_adjustments WHERE kind<>'reschedule') THEN
      RAISE EXCEPTION 'Cannot roll back persisted automatic recovery history'; END IF; END $$`);
    await queryRunner.query(`DROP TABLE "job_leases"`);
    await queryRunner.query(`DROP INDEX "payment_refunds_unresolved_idx"`);
    await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_status_check"`);
    await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'pending_retry'::text, 'succeeded'::text, 'failed'::text])))`);
    await queryRunner.query(`ALTER TABLE "booking_adjustments" DROP CONSTRAINT "booking_adjustments_kind_check"`);
    await queryRunner.query(`ALTER TABLE "booking_adjustments" DROP COLUMN "kind"`);
  }
}
