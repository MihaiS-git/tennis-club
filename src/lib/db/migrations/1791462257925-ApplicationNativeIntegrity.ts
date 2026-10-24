import type { MigrationInterface, QueryRunner } from "typeorm";

// PostgreSQL structural guards, expression index and bootstrap records complement the generated schema. No application policy triggers.
export class ApplicationNativeIntegrity1791462257925 implements MigrationInterface {
  name = "ApplicationNativeIntegrity1791462257925";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE FUNCTION public.protect_payment_attempt() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
        IF TG_OP <> 'UPDATE' THEN
          RAISE EXCEPTION 'Payment requests cannot be removed' USING ERRCODE='23514';
        END IF;
        IF (to_jsonb(NEW)-ARRAY['status','provider_payment_id','updated_at','completed_at','checkout_token_hash']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['status','provider_payment_id','updated_at','completed_at','checkout_token_hash']) THEN
          RAISE EXCEPTION 'Payment request facts are immutable' USING ERRCODE='23514';
        END IF;
        IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
          RAISE EXCEPTION 'Payment provider identity is write-once' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER payment_attempts_immutable BEFORE UPDATE OR DELETE ON public.payment_attempts
      FOR EACH ROW EXECUTE FUNCTION public.protect_payment_attempt()`);
    await queryRunner.query(`CREATE TRIGGER payment_attempts_no_truncate BEFORE TRUNCATE ON public.payment_attempts
      FOR EACH STATEMENT EXECUTE FUNCTION public.protect_payment_attempt()`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.protect_payment_attempt() FROM PUBLIC, anon, authenticated, service_role`);
    await queryRunner.query(`CREATE FUNCTION public.protect_capture_receipt() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
        IF TG_OP <> 'UPDATE' THEN
          RAISE EXCEPTION 'Capture receipts cannot be removed' USING ERRCODE='23514';
        END IF;
        IF (to_jsonb(NEW)-'last_observed_at') IS DISTINCT FROM (to_jsonb(OLD)-'last_observed_at')
          OR NEW.last_observed_at < OLD.last_observed_at THEN
          RAISE EXCEPTION 'Capture facts are immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER payment_capture_receipts_immutable BEFORE UPDATE OR DELETE ON public.payment_capture_receipts
      FOR EACH ROW EXECUTE FUNCTION public.protect_capture_receipt()`);
    await queryRunner.query(`CREATE TRIGGER payment_capture_receipts_no_truncate BEFORE TRUNCATE ON public.payment_capture_receipts
      FOR EACH STATEMENT EXECUTE FUNCTION public.protect_capture_receipt()`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.protect_capture_receipt() FROM PUBLIC, anon, authenticated, service_role`);
    await queryRunner.query(`CREATE FUNCTION public.protect_provider_event() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
        IF TG_OP <> 'UPDATE' THEN
          RAISE EXCEPTION 'Provider events cannot be removed' USING ERRCODE='23514';
        END IF;
        IF (to_jsonb(NEW)-ARRAY['reconciliation_required','resolved_at','resolved_by_user_id']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['reconciliation_required','resolved_at','resolved_by_user_id']) THEN
          RAISE EXCEPTION 'Provider event facts are immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER payment_provider_events_immutable BEFORE UPDATE OR DELETE ON public.payment_provider_events
      FOR EACH ROW EXECUTE FUNCTION public.protect_provider_event()`);
    await queryRunner.query(`CREATE TRIGGER payment_provider_events_no_truncate BEFORE TRUNCATE ON public.payment_provider_events
      FOR EACH STATEMENT EXECUTE FUNCTION public.protect_provider_event()`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.protect_provider_event() FROM PUBLIC, anon, authenticated, service_role`);
    await queryRunner.query(`CREATE FUNCTION public.protect_refund_execution() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ DECLARE fact text; BEGIN
        IF TG_OP <> 'UPDATE' THEN
          RAISE EXCEPTION 'Refund execution history cannot be removed' USING ERRCODE='23514';
        END IF;
        IF (to_jsonb(NEW)-ARRAY['status','lease_token','lease_until','last_checked_at','last_error','updated_at',
            'dispatch_initiated_at','provider_refund_id','first_uncertain_at','first_uncertainty_evidence',
            'terminal_result','terminal_evidence','completed_at']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['status','lease_token','lease_until','last_checked_at','last_error','updated_at',
            'dispatch_initiated_at','provider_refund_id','first_uncertain_at','first_uncertainty_evidence',
            'terminal_result','terminal_evidence','completed_at']) THEN
          RAISE EXCEPTION 'Refund execution request is immutable' USING ERRCODE='23514';
        END IF;
        FOREACH fact IN ARRAY ARRAY['dispatch_initiated_at','provider_refund_id','first_uncertain_at',
          'first_uncertainty_evidence','terminal_result','terminal_evidence','completed_at'] LOOP
          IF (to_jsonb(OLD)->fact) <> 'null'::jsonb
            AND (to_jsonb(NEW)->fact) IS DISTINCT FROM (to_jsonb(OLD)->fact) THEN
            RAISE EXCEPTION 'Refund execution evidence is write-once' USING ERRCODE='23514';
          END IF;
        END LOOP;
        IF OLD.terminal_result IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
          RAISE EXCEPTION 'Terminal refund execution cannot regress' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER refund_executions_immutable BEFORE UPDATE OR DELETE ON public.refund_executions
      FOR EACH ROW EXECUTE FUNCTION public.protect_refund_execution()`);
    await queryRunner.query(`CREATE TRIGGER refund_executions_no_truncate BEFORE TRUNCATE ON public.refund_executions
      FOR EACH STATEMENT EXECUTE FUNCTION public.protect_refund_execution()`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.protect_refund_execution() FROM PUBLIC, anon, authenticated, service_role`);
    await queryRunner.query(`CREATE FUNCTION public.protect_booking_ownership() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
        RAISE EXCEPTION 'Booking ownership is immutable' USING ERRCODE='23514';
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER bookings_ownership_immutable BEFORE UPDATE OF account_user_id ON public.bookings
      FOR EACH ROW WHEN (NEW.account_user_id IS DISTINCT FROM OLD.account_user_id)
      EXECUTE FUNCTION public.protect_booking_ownership()`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.protect_booking_ownership() FROM PUBLIC, anon, authenticated, service_role`);
    // Surcharge capture acceptance is recorded once; every other proposal fact is fixed.
    await queryRunner.query(`CREATE FUNCTION public.protect_financial_context() RETURNS trigger
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
    await queryRunner.query(`CREATE TRIGGER booking_adjustments_immutable BEFORE UPDATE ON public.booking_adjustments
      FOR EACH ROW EXECUTE FUNCTION public.protect_financial_context()`);
    await queryRunner.query(`CREATE TRIGGER payment_refunds_immutable BEFORE UPDATE ON public.payment_refunds
      FOR EACH ROW EXECUTE FUNCTION public.protect_financial_context()`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.protect_financial_context() FROM PUBLIC, anon, authenticated, service_role`);
    await queryRunner.query(`CREATE FUNCTION public.protect_booking_revision() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
        RAISE EXCEPTION 'Booking revisions are append-only' USING ERRCODE='23514';
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER booking_revisions_immutable BEFORE UPDATE OR DELETE ON public.booking_revisions
      FOR EACH ROW EXECUTE FUNCTION public.protect_booking_revision()`);
    await queryRunner.query(`CREATE TRIGGER booking_revisions_no_truncate BEFORE TRUNCATE ON public.booking_revisions
      FOR EACH STATEMENT EXECUTE FUNCTION public.protect_booking_revision()`);
    await queryRunner.query(`CREATE FUNCTION public.validate_booking_revision_append() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ DECLARE head uuid; predecessor integer; BEGIN
        SELECT current_revision_id INTO head FROM public.bookings WHERE id=NEW.booking_id FOR UPDATE;
        IF NEW.revision_number=1 THEN
          IF head IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Invalid initial revision pointer' USING ERRCODE='23514'; END IF;
        ELSE
          SELECT revision_number INTO predecessor FROM public.booking_revisions
            WHERE booking_id=NEW.booking_id AND id=NEW.previous_revision_id;
          IF head IS DISTINCT FROM NEW.previous_revision_id OR predecessor IS NULL OR predecessor+1<>NEW.revision_number THEN
            RAISE EXCEPTION 'Revision history must be linear' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER booking_revisions_linear BEFORE INSERT ON public.booking_revisions
      FOR EACH ROW EXECUTE FUNCTION public.validate_booking_revision_append()`);
    await queryRunner.query(`CREATE FUNCTION public.validate_booking_revision_head() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ DECLARE booking uuid; head uuid; latest uuid; BEGIN
        IF TG_TABLE_NAME='bookings' THEN booking:=NEW.id; ELSE booking:=NEW.booking_id; END IF;
        SELECT current_revision_id INTO head FROM public.bookings WHERE id=booking;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT id INTO latest FROM public.booking_revisions WHERE booking_id=booking ORDER BY revision_number DESC LIMIT 1;
        IF latest IS NULL OR head IS DISTINCT FROM latest THEN
          RAISE EXCEPTION 'Current revision must be the history head' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END; $$`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER bookings_revision_head AFTER INSERT OR UPDATE OF current_revision_id ON public.bookings
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_booking_revision_head()`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER booking_revisions_head AFTER INSERT ON public.booking_revisions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_booking_revision_head()`);
    for (const name of ["protect_booking_revision", "validate_booking_revision_append", "validate_booking_revision_head"]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated, service_role`);
    }
    await queryRunner.query(`CREATE FUNCTION public.protect_booking_financial_exception() RETURNS trigger
      LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN
        RAISE EXCEPTION 'Booking financial exceptions are immutable' USING ERRCODE='23514';
      END; $$`);
    await queryRunner.query(`CREATE TRIGGER booking_financial_exceptions_immutable BEFORE UPDATE OR DELETE ON public.booking_financial_exceptions
      FOR EACH ROW EXECUTE FUNCTION public.protect_booking_financial_exception()`);
    await queryRunner.query(`CREATE TRIGGER booking_financial_exceptions_no_truncate BEFORE TRUNCATE ON public.booking_financial_exceptions
      FOR EACH STATEMENT EXECUTE FUNCTION public.protect_booking_financial_exception()`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.protect_booking_financial_exception() FROM PUBLIC, anon, authenticated, service_role`);

    await queryRunner.query(`CREATE UNIQUE INDEX users_email_lower_unique ON public.users (lower(email))`);
    await queryRunner.query(`CREATE UNIQUE INDEX email_deliveries_event_recipient_key ON public.email_deliveries (event_key, lower(recipient_email))`);
    await queryRunner.query(`INSERT INTO public.roles(code) VALUES ('admin'), ('coach')`);
    await queryRunner.query(`INSERT INTO public.payment_provider_settings(id) VALUES (true)`);
    await queryRunner.query(`INSERT INTO public.club_settings(id) VALUES (true)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Removing the guards must not enable a subsequent schema rollback to erase history.
    await queryRunner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.refund_executions) THEN
      RAISE EXCEPTION 'Cannot roll back persisted refund execution history'; END IF;
      IF EXISTS (SELECT 1 FROM public.booking_financial_exceptions) THEN
      RAISE EXCEPTION 'Cannot discard booking financial exception evidence'; END IF; END $$`);
    await queryRunner.query(`DROP TRIGGER booking_financial_exceptions_no_truncate ON public.booking_financial_exceptions`);
    await queryRunner.query(`DROP TRIGGER booking_financial_exceptions_immutable ON public.booking_financial_exceptions`);
    await queryRunner.query(`DROP FUNCTION public.protect_booking_financial_exception()`);
    await queryRunner.query(`DROP TRIGGER refund_executions_no_truncate ON public.refund_executions`);
    await queryRunner.query(`DROP TRIGGER refund_executions_immutable ON public.refund_executions`);
    await queryRunner.query(`DROP FUNCTION public.protect_refund_execution()`);
    await queryRunner.query(`DROP TRIGGER payment_provider_events_no_truncate ON public.payment_provider_events`);
    await queryRunner.query(`DROP TRIGGER payment_provider_events_immutable ON public.payment_provider_events`);
    await queryRunner.query(`DROP FUNCTION public.protect_provider_event()`);
    await queryRunner.query(`DROP TRIGGER payment_capture_receipts_no_truncate ON public.payment_capture_receipts`);
    await queryRunner.query(`DROP TRIGGER payment_capture_receipts_immutable ON public.payment_capture_receipts`);
    await queryRunner.query(`DROP FUNCTION public.protect_capture_receipt()`);
    await queryRunner.query(`DROP TRIGGER payment_attempts_no_truncate ON public.payment_attempts`);
    await queryRunner.query(`DROP TRIGGER payment_attempts_immutable ON public.payment_attempts`);
    await queryRunner.query(`DROP FUNCTION public.protect_payment_attempt()`);
    await queryRunner.query(`DROP TRIGGER bookings_ownership_immutable ON public.bookings`);
    await queryRunner.query(`DROP FUNCTION public.protect_booking_ownership()`);
    await queryRunner.query(`DROP TRIGGER booking_adjustments_immutable ON public.booking_adjustments`);
    await queryRunner.query(`DROP TRIGGER payment_refunds_immutable ON public.payment_refunds`);
    await queryRunner.query(`DROP FUNCTION public.protect_financial_context()`);
    await queryRunner.query(`DROP TRIGGER bookings_revision_head ON public.bookings`);
    for (const name of ["booking_revisions_head", "booking_revisions_linear", "booking_revisions_immutable", "booking_revisions_no_truncate"]) {
      await queryRunner.query(`DROP TRIGGER ${name} ON public.booking_revisions`);
    }
    for (const name of ["validate_booking_revision_head", "validate_booking_revision_append", "protect_booking_revision"]) {
      await queryRunner.query(`DROP FUNCTION public.${name}()`);
    }
    await queryRunner.query(`DELETE FROM public.club_settings WHERE id = true`);
    await queryRunner.query(`DELETE FROM public.payment_provider_settings WHERE id = true`);
    await queryRunner.query(`DELETE FROM public.roles WHERE code IN ('admin', 'coach')`);
    await queryRunner.query(`DROP INDEX public.email_deliveries_event_recipient_key`);
    await queryRunner.query(`DROP INDEX public.users_email_lower_unique`);
  }
}
