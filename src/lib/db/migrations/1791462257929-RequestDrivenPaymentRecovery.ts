import type { MigrationInterface, QueryRunner } from "typeorm";

// Payment outcomes are now driven by requests, signed Stripe webhooks and an
// explicit Admin check; no scheduler runs. job_leases and the scheduler-only scan
// index are dropped. Important financial notices are also shown in-app to the
// booking owner until acknowledged; email delivery is not proof of reading.
export class RequestDrivenPaymentRecovery1791462257929 implements MigrationInterface {
  name = "RequestDrivenPaymentRecovery1791462257929";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "job_leases"`);
    await queryRunner.query(`DROP INDEX "payment_refunds_unresolved_idx"`);
    await queryRunner.query(`ALTER TABLE public.booking_notification_deliveries
      ADD booking_id uuid REFERENCES public.bookings(id) ON DELETE CASCADE,
      ADD requires_acknowledgement boolean NOT NULL DEFAULT false,
      ADD acknowledged_at timestamptz,
      ADD CONSTRAINT booking_notification_deliveries_acknowledgement_check
        CHECK ((NOT requires_acknowledgement OR booking_id IS NOT NULL) AND (acknowledged_at IS NULL OR requires_acknowledgement))`);
    await queryRunner.query(`CREATE INDEX booking_notification_deliveries_unacknowledged
      ON public.booking_notification_deliveries(booking_id) WHERE requires_acknowledgement AND acknowledged_at IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.booking_notification_deliveries WHERE requires_acknowledgement) THEN
      RAISE EXCEPTION 'Cannot discard customer financial notice acknowledgements'; END IF; END $$`);
    await queryRunner.query(`DROP INDEX public.booking_notification_deliveries_unacknowledged`);
    await queryRunner.query(`ALTER TABLE public.booking_notification_deliveries
      DROP CONSTRAINT booking_notification_deliveries_acknowledgement_check,
      DROP COLUMN acknowledged_at, DROP COLUMN requires_acknowledgement, DROP COLUMN booking_id`);
    await queryRunner.query(`CREATE INDEX "payment_refunds_unresolved_idx" ON "payment_refunds" ("updated_at") WHERE status IN ('pending', 'pending_retry')`);
    await queryRunner.query(`CREATE TABLE "job_leases" ("name" text NOT NULL, "lease_token" uuid, "lease_until" TIMESTAMP WITH TIME ZONE, "last_started_at" TIMESTAMP WITH TIME ZONE, "last_completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "job_leases_name_check" CHECK (name ~ '^[a-z][a-z0-9_]*$'), CONSTRAINT "job_leases_lease_check" CHECK ((lease_token IS NULL) = (lease_until IS NULL) AND (lease_until IS NULL OR isfinite(lease_until))), CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name"))`);
    await queryRunner.query(`REVOKE ALL ON TABLE public.job_leases FROM PUBLIC, anon, authenticated`);
  }
}
