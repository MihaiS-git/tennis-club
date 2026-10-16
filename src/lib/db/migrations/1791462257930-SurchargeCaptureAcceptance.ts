import type { MigrationInterface, QueryRunner } from "typeorm";

export class SurchargeCaptureAcceptance1791462257930 implements MigrationInterface {
  name = "SurchargeCaptureAcceptance1791462257930";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.booking_adjustments ADD capture_accepted_at timestamptz`);
    await queryRunner.query(`CREATE OR REPLACE FUNCTION public.protect_financial_context() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
        IF TG_TABLE_NAME='booking_adjustments' THEN
          IF (to_jsonb(NEW)-ARRAY['status','updated_at','capture_accepted_at']) IS DISTINCT FROM
             (to_jsonb(OLD)-ARRAY['status','updated_at','capture_accepted_at']) THEN
            RAISE EXCEPTION 'Adjustment proposal facts are immutable' USING ERRCODE='23514';
          END IF;
          IF OLD.capture_accepted_at IS NOT NULL AND NEW.capture_accepted_at IS DISTINCT FROM OLD.capture_accepted_at THEN
            RAISE EXCEPTION 'Capture acceptance is immutable' USING ERRCODE='23514';
          END IF;
        ELSE
          IF (to_jsonb(NEW)-ARRAY['status','updated_at']) IS DISTINCT FROM
             (to_jsonb(OLD)-ARRAY['status','updated_at']) THEN
            RAISE EXCEPTION 'Refund obligation facts are immutable' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$`);
    // Preserve acceptance already recorded by the previous exact hold extension.
    // No evidence is inferred for zero-fragment proposals.
    await queryRunner.query(`UPDATE public.booking_adjustments a SET capture_accepted_at=a.expires_at-interval '1 microsecond'
      WHERE a.status='pending' AND a.kind='reschedule' AND a.new_total>a.original_total
        AND EXISTS (SELECT 1 FROM public.court_reservations r WHERE r.adjustment_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM public.court_reservations r WHERE r.adjustment_id=a.id
          AND (r.status<>'held' OR r.hold_expires_at<>a.expires_at+interval '120 seconds'))`);
    await queryRunner.query(`ALTER TABLE public.booking_adjustments ADD CONSTRAINT booking_adjustments_capture_acceptance_check
      CHECK (capture_accepted_at IS NULL OR (isfinite(capture_accepted_at) AND capture_accepted_at < expires_at AND kind='reschedule' AND new_total > original_total))`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.booking_adjustments WHERE capture_accepted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot discard surcharge capture acceptance'; END IF; END $$`);
    await queryRunner.query(`CREATE OR REPLACE FUNCTION public.protect_financial_context() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
        IF (to_jsonb(NEW)-ARRAY['status','updated_at']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['status','updated_at']) THEN
          IF TG_TABLE_NAME='booking_adjustments' THEN
            RAISE EXCEPTION 'Adjustment proposal facts are immutable' USING ERRCODE='23514';
          ELSE
            RAISE EXCEPTION 'Refund obligation facts are immutable' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`ALTER TABLE public.booking_adjustments DROP CONSTRAINT booking_adjustments_capture_acceptance_check,
      DROP COLUMN capture_accepted_at`);
  }
}
