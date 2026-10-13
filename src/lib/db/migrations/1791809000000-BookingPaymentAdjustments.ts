import type { MigrationInterface, QueryRunner } from "typeorm";

export class BookingPaymentAdjustments1791809000000 implements MigrationInterface {
  name = "BookingPaymentAdjustments1791809000000";
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE public.booking_adjustments (
      id uuid PRIMARY KEY, booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
      actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
      scope text NOT NULL CHECK(scope IN ('owner','admin')), request_key text NOT NULL,
      target jsonb NOT NULL CHECK(jsonb_typeof(target)='object'), original_total integer NOT NULL CHECK(original_total>0),
      new_total integer NOT NULL CHECK(new_total>0), currency text NOT NULL,
      status text NOT NULL CHECK(status IN ('pending','applied','cancelled','expired','unsuccessful')),
      expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT booking_adjustments_request UNIQUE(booking_id,request_key))`);
    await runner.query("CREATE UNIQUE INDEX booking_adjustments_pending ON public.booking_adjustments(booking_id) WHERE status='pending'");
    await runner.query("REVOKE ALL ON public.booking_adjustments FROM anon, authenticated");
    await runner.query(`ALTER TABLE public.payment_attempts ADD COLUMN adjustment_id uuid
      REFERENCES public.booking_adjustments(id) ON DELETE RESTRICT`);
    await runner.query("CREATE UNIQUE INDEX payment_attempts_one_adjustment ON public.payment_attempts(adjustment_id) WHERE adjustment_id IS NOT NULL");
    await runner.query(`ALTER TABLE public.court_reservations ADD COLUMN adjustment_id uuid
      REFERENCES public.booking_adjustments(id) ON DELETE CASCADE`);
    await runner.query(`ALTER TABLE public.court_reservations DROP CONSTRAINT court_reservation_time_check,
      ADD CONSTRAINT court_reservation_time_check CHECK(starts_at_minute%30=0 AND ends_at_minute%30=0
        AND ends_at_minute-starts_at_minute >= CASE WHEN adjustment_id IS NULL THEN 60 ELSE 30 END),
      ADD CONSTRAINT adjustment_reservation_state CHECK(adjustment_id IS NULL OR status IN ('held','released'))`);
    await runner.query("CREATE INDEX adjustment_reservations ON public.court_reservations(adjustment_id) WHERE adjustment_id IS NOT NULL");
    await runner.query(`ALTER TABLE public.payment_refunds DROP CONSTRAINT payment_refunds_booking_id_key,
      DROP CONSTRAINT payment_refunds_payment_attempt_id_key,
      ADD COLUMN operation_key text NOT NULL DEFAULT 'cancellation',
      ADD COLUMN adjustment_id uuid REFERENCES public.booking_adjustments(id) ON DELETE RESTRICT,
      ADD COLUMN provider_generation integer NOT NULL DEFAULT 0 CHECK(provider_generation>=0),
      ADD COLUMN provider_history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(provider_history)='array'),
      ADD COLUMN captured_amount_minor integer CHECK(captured_amount_minor>0 AND amount_minor<=captured_amount_minor),
      ADD CONSTRAINT payment_refunds_operation UNIQUE(payment_attempt_id,operation_key)`);
    await runner.query(`UPDATE public.payment_refunds f SET captured_amount_minor=p.amount_minor
      FROM public.payment_attempts p WHERE p.id=f.payment_attempt_id`);
    await runner.query("CREATE INDEX payment_refunds_booking_idx ON public.payment_refunds(booking_id)");
  }
  async down(runner: QueryRunner) {
    const rows: unknown[] = await runner.query("SELECT id FROM public.booking_adjustments LIMIT 1");
    if (rows.length) throw new Error("Cannot discard booking adjustment financial history");
    await runner.query(`ALTER TABLE public.payment_refunds DROP CONSTRAINT payment_refunds_operation,
      DROP COLUMN operation_key,DROP COLUMN adjustment_id,DROP COLUMN IF EXISTS captured_amount_minor,DROP COLUMN IF EXISTS provider_generation,DROP COLUMN IF EXISTS provider_history,
      ADD CONSTRAINT payment_refunds_booking_id_key UNIQUE(booking_id),
      ADD CONSTRAINT payment_refunds_payment_attempt_id_key UNIQUE(payment_attempt_id)`);
    await runner.query("DROP INDEX public.payment_refunds_booking_idx");
    await runner.query(`ALTER TABLE public.court_reservations DROP CONSTRAINT adjustment_reservation_state,
      DROP CONSTRAINT court_reservation_time_check,DROP COLUMN adjustment_id,
      ADD CONSTRAINT court_reservation_time_check CHECK(starts_at_minute%30=0 AND ends_at_minute%30=0 AND ends_at_minute-starts_at_minute>=60)`);
    await runner.query("ALTER TABLE public.payment_attempts DROP COLUMN adjustment_id");
    await runner.query("DROP TABLE public.booking_adjustments");
  }
}
