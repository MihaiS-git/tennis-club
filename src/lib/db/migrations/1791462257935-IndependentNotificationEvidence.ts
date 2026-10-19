import type { MigrationInterface, QueryRunner } from "typeorm";

export class IndependentNotificationEvidence1791462257935 implements MigrationInterface {
  name = "IndependentNotificationEvidence1791462257935";
  async up(runner: QueryRunner): Promise<void> {
    // No default/backfill: only new writers explicitly opt in to reconstruction.
    await runner.query(`ALTER TABLE public.booking_revisions ADD COLUMN recovery_version smallint,
      ADD CONSTRAINT booking_revisions_recovery_version CHECK (recovery_version=1)`);
    await runner.query(`ALTER TABLE public.booking_adjustments ADD COLUMN recovery_version smallint,
      ADD CONSTRAINT booking_adjustments_recovery_version CHECK (recovery_version=1)`);
    await runner.query(`ALTER TABLE public.booking_notification_deliveries
      DROP CONSTRAINT booking_notification_deliveries_dismissed_check`);
    await runner.query(`CREATE TABLE public.booking_financial_exceptions (
      event_key text PRIMARY KEY, booking_id uuid NOT NULL, revision_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      kind text NOT NULL CHECK (kind IN ('cancellation_rejected','modification_rejected',
        'refunded_modification_unapplied','surcharge_unapplied','late_capture',
        'refund_failed','refund_unresolved','refund_reversed')),
      adjustment_id uuid REFERENCES public.booking_adjustments(id),
      payment_attempt_id uuid REFERENCES public.payment_attempts(id),
      refund_id uuid REFERENCES public.payment_refunds(id),
      CONSTRAINT booking_financial_exceptions_revision FOREIGN KEY (booking_id,revision_id)
        REFERENCES public.booking_revisions(booking_id,id),
      CHECK (isfinite(occurred_at)),
      CHECK (adjustment_id IS NOT NULL OR payment_attempt_id IS NOT NULL OR refund_id IS NOT NULL))`);
    await runner.query(`CREATE INDEX booking_financial_exceptions_booking ON public.booking_financial_exceptions(booking_id)`);
    await runner.query(`REVOKE ALL ON public.booking_financial_exceptions FROM PUBLIC,anon,authenticated,service_role`);
    await runner.query(`CREATE FUNCTION public.protect_booking_financial_exception() RETURNS trigger
      LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
        RAISE EXCEPTION 'Booking financial exceptions are immutable' USING ERRCODE='23514';
      END $$`);
    await runner.query(`CREATE TRIGGER booking_financial_exceptions_immutable BEFORE UPDATE OR DELETE
      ON public.booking_financial_exceptions FOR EACH ROW EXECUTE FUNCTION public.protect_booking_financial_exception()`);
    await runner.query(`CREATE TRIGGER booking_financial_exceptions_no_truncate BEFORE TRUNCATE
      ON public.booking_financial_exceptions FOR EACH STATEMENT EXECUTE FUNCTION public.protect_booking_financial_exception()`);
    await runner.query(`REVOKE ALL ON FUNCTION public.protect_booking_financial_exception() FROM PUBLIC,anon,authenticated,service_role`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.booking_financial_exceptions)
      OR EXISTS(SELECT 1 FROM public.booking_revisions WHERE recovery_version=1)
      OR EXISTS(SELECT 1 FROM public.booking_adjustments WHERE recovery_version=1)
      OR EXISTS(SELECT 1 FROM public.booking_notification_deliveries WHERE dismissed_at IS NOT NULL AND NOT requires_acknowledgement)
      THEN RAISE EXCEPTION 'Cannot discard independent recovery evidence or dismissals'; END IF; END $$`);
    await runner.query(`DROP TABLE public.booking_financial_exceptions`);
    await runner.query(`DROP FUNCTION public.protect_booking_financial_exception()`);
    await runner.query(`ALTER TABLE public.booking_revisions DROP COLUMN recovery_version`);
    await runner.query(`ALTER TABLE public.booking_adjustments DROP COLUMN recovery_version`);
    await runner.query(`ALTER TABLE public.booking_notification_deliveries
      ADD CONSTRAINT booking_notification_deliveries_dismissed_check CHECK (dismissed_at IS NULL OR requires_acknowledgement)`);
  }
}
