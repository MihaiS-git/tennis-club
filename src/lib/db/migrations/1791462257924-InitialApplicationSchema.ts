import type { MigrationInterface, QueryRunner } from "typeorm";

export class InitialApplicationSchema1791462257924 implements MigrationInterface {
    name = 'InitialApplicationSchema1791462257924'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Final-state application schema generated from the TypeORM entity metadata.
        // Required before entity-generated overlap exclusions; retain on rollback.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions`);
        await queryRunner.query(`SET LOCAL search_path = public, extensions`);
        await queryRunner.query(`CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL, "email" text NOT NULL, "status" "public"."user_status" NOT NULL DEFAULT 'active', "first_name" text, "last_name" text, "phone" text, "date_of_birth" date, "address_line1" text, "address_line2" text, "city" text, "postal_code" text, "country_code" character(2), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "users_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "user_messages" ("id" uuid NOT NULL, "user_id" uuid NOT NULL, "event_key" text NOT NULL, "kind" text NOT NULL, "subject" text NOT NULL, "body_text" text NOT NULL, "href" text, "read_at" TIMESTAMP WITH TIME ZONE, "deleted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "user_messages_pkey" PRIMARY KEY ("id"), CONSTRAINT "user_messages_user_event_key" UNIQUE ("user_id", "event_key"), CONSTRAINT "user_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE)`);
        await queryRunner.query(`CREATE INDEX "user_messages_newest_idx" ON "user_messages" ("user_id", "created_at" DESC, "id" DESC) WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE INDEX "user_messages_unread_idx" ON "user_messages" ("user_id") WHERE read_at IS NULL AND deleted_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "email_deliveries" ("id" uuid NOT NULL, "event_key" text NOT NULL, "recipient_email" text NOT NULL, "subject" text NOT NULL, "body_text" text NOT NULL, "body_html" text NOT NULL, "status" text NOT NULL, "attempts" integer NOT NULL DEFAULT 0, "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL, "locked_until" TIMESTAMP WITH TIME ZONE, "provider_message_id" text, "last_error" text, "suppressed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id"), CONSTRAINT "email_deliveries_status_check" CHECK (status IN ('pending', 'processing', 'accepted', 'sandbox_accepted', 'failed')), CONSTRAINT "email_deliveries_attempts_check" CHECK (attempts >= 0))`);
        await queryRunner.query(`CREATE INDEX "email_deliveries_due_idx" ON "email_deliveries" ("next_attempt_at", "id") WHERE status IN ('pending', 'processing')`);
        await queryRunner.query(`CREATE TABLE "player_profiles" ("user_id" uuid NOT NULL, "display_name" text, "avatar_path" text, "sportya_level" text, "rating" integer, "handedness" text, "backhand" text, "preferred_game" text, "preferred_surface" text, "bio" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "player_profiles_preferred_surface_check" CHECK (preferred_surface = ANY (ARRAY['clay'::text, 'hard'::text, 'grass'::text, 'carpet'::text, 'any'::text])), CONSTRAINT "player_profiles_preferred_game_check" CHECK (preferred_game = ANY (ARRAY['singles'::text, 'doubles'::text, 'both'::text])), CONSTRAINT "player_profiles_handedness_check" CHECK (handedness = ANY (ARRAY['right'::text, 'left'::text])), CONSTRAINT "player_profiles_backhand_check" CHECK (backhand = ANY (ARRAY['one_handed'::text, 'two_handed'::text])), CONSTRAINT "player_profiles_pkey" PRIMARY KEY ("user_id"))`);
        await queryRunner.query(`CREATE TABLE "roles" ("code" text NOT NULL, CONSTRAINT "roles_code_format" CHECK (code ~ '^[a-z][a-z0-9_]*$'::text), CONSTRAINT "roles_pkey" PRIMARY KEY ("code"))`);
        await queryRunner.query(`CREATE TABLE "user_roles" ("user_id" uuid NOT NULL, "role_code" text NOT NULL, "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "assigned_by" uuid, CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role_code"))`);
        await queryRunner.query(`CREATE INDEX "user_roles_role_code_idx" ON "user_roles"  ("role_code") `);
        await queryRunner.query(`CREATE TABLE "locations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "name" text NOT NULL, "slug" text NOT NULL, "address_line1" text, "address_line2" text, "city" text, "postal_code" text, "country_code" text, "timezone" text NOT NULL, "currency" text NOT NULL DEFAULT 'EUR', "is_active" boolean NOT NULL DEFAULT true, "archived_at" TIMESTAMP WITH TIME ZONE, "display_order" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "is_public" boolean NOT NULL DEFAULT false, "customer_cancellation_notice_minutes" integer NOT NULL DEFAULT '1440', "allow_pay_at_club" boolean NOT NULL DEFAULT false, CONSTRAINT "locations_slug_key" UNIQUE ("slug"), CONSTRAINT "locations_customer_cancellation_notice_check" CHECK (customer_cancellation_notice_minutes >= 0 AND customer_cancellation_notice_minutes <= 43200), CONSTRAINT "locations_currency_check" CHECK (currency = ANY (ARRAY['EUR'::text, 'USD'::text, 'GBP'::text, 'RON'::text, 'CHF'::text])), CONSTRAINT "locations_archived_inactive_check" CHECK (archived_at IS NULL OR NOT is_active), CONSTRAINT "locations_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "booking_adjustments" ("base_revision_id" uuid NOT NULL, "id" uuid NOT NULL, "booking_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "scope" text NOT NULL, "kind" text NOT NULL DEFAULT 'reschedule', "request_key" text NOT NULL, "target" jsonb NOT NULL, "original_total" integer NOT NULL, "new_total" integer NOT NULL, "currency" text NOT NULL, "status" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "capture_accepted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "booking_adjustments_request" UNIQUE ("booking_id", "request_key"), CONSTRAINT "booking_adjustments_identity" UNIQUE ("booking_id", "id"), CONSTRAINT "booking_adjustments_capture_acceptance_check" CHECK (capture_accepted_at IS NULL OR (isfinite(capture_accepted_at) AND capture_accepted_at < expires_at AND kind='reschedule' AND new_total > original_total)), CONSTRAINT "booking_adjustments_expires_at_check" CHECK (isfinite(expires_at)), CONSTRAINT "booking_adjustments_status_check" CHECK (status IN ('pending', 'applied', 'cancelled', 'expired', 'unsuccessful')), CONSTRAINT "booking_adjustments_new_total_check" CHECK (new_total > 0), CONSTRAINT "booking_adjustments_original_total_check" CHECK (original_total > 0), CONSTRAINT "booking_adjustments_target_display_check" CHECK (jsonb_typeof(target->'courtName')='string' AND jsonb_typeof(target->'locationName')='string' AND jsonb_typeof(target->'timezone')='string' AND char_length(btrim(target->>'courtName')) BETWEEN 1 AND 255 AND char_length(btrim(target->>'locationName')) BETWEEN 1 AND 255 AND char_length(btrim(target->>'timezone')) BETWEEN 1 AND 100 AND target ?& ARRAY['courtName','locationName','timezone']), CONSTRAINT "booking_adjustments_target_check" CHECK (jsonb_typeof(target) = 'object'), CONSTRAINT "booking_adjustments_kind_check" CHECK (kind IN ('reschedule', 'cancellation')), CONSTRAINT "booking_adjustments_scope_check" CHECK (scope IN ('owner', 'admin')), CONSTRAINT "booking_adjustments_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "booking_adjustments_pending" ON "booking_adjustments"  ("booking_id") WHERE status='pending'`);
        await queryRunner.query(`CREATE TABLE "coach_profiles" ("user_id" uuid NOT NULL, "display_name" text NOT NULL, "bio" text NOT NULL, "qualifications" text NOT NULL, "specialties" text array NOT NULL, "languages" text array NOT NULL, "is_public" boolean NOT NULL DEFAULT false, "archived_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "coach_profiles_lists_check" CHECK (cardinality(specialties) <= 12 AND cardinality(languages) <= 12), CONSTRAINT "coach_profiles_text_check" CHECK (char_length(bio) <= 2000 AND char_length(qualifications) <= 1000), CONSTRAINT "coach_profiles_display_name_check" CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 100), CONSTRAINT "coach_profiles_pkey" PRIMARY KEY ("user_id"))`);
        await queryRunner.query(`CREATE TABLE "courts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "location_id" uuid NOT NULL, "name" text NOT NULL, "slug" text NOT NULL, "surface" text NOT NULL, "environment" text NOT NULL, "has_lighting" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "courts_location_id_slug_key" UNIQUE ("location_id", "slug"), CONSTRAINT "courts_surface_check" CHECK (surface = ANY (ARRAY['clay'::text, 'hard'::text, 'grass'::text, 'carpet'::text])), CONSTRAINT "courts_environment_check" CHECK (environment = ANY (ARRAY['outdoor'::text, 'indoor'::text])), CONSTRAINT "courts_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."court_reservation_status" AS ENUM('active', 'cancelled', 'held', 'released')`);
        await queryRunner.query(`CREATE TABLE "court_reservations" ("adjustment_id" uuid, "id" uuid NOT NULL DEFAULT gen_random_uuid(), "court_id" uuid NOT NULL, "booking_date" date NOT NULL, "starts_at_minute" integer NOT NULL, "ends_at_minute" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "reason" text, "created_by_user_id" uuid, "status" "public"."court_reservation_status" NOT NULL DEFAULT 'active', "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancelled_by_user_id" uuid, "hold_expires_at" TIMESTAMP WITH TIME ZONE, "coach_user_id" uuid, "occupies_court" boolean NOT NULL DEFAULT true, CONSTRAINT "court_reservation_coach_only_hold" CHECK (occupies_court OR (adjustment_id IS NOT NULL AND coach_user_id IS NOT NULL)), CONSTRAINT "court_reservations_starts_at_minute_check" CHECK (((starts_at_minute >= 0) AND (starts_at_minute <= 1439))), CONSTRAINT "court_reservations_ends_at_minute_check" CHECK (((ends_at_minute >= 1) AND (ends_at_minute <= 1440))), CONSTRAINT "court_reservations_booking_date_check" CHECK (isfinite(booking_date)), CONSTRAINT "court_reservation_time_check" CHECK ((((starts_at_minute % 30) = 0) AND ((ends_at_minute % 30) = 0) AND ((ends_at_minute - starts_at_minute) >= CASE WHEN adjustment_id IS NULL THEN 60 ELSE 30 END))), CONSTRAINT "court_reservation_reason_check" CHECK (((reason IS NULL) OR ((char_length(reason) <= 255) AND (char_length(btrim(reason)) > 0)))), CONSTRAINT "court_reservation_hold_check" CHECK ((((status = 'held'::public.court_reservation_status) AND (hold_expires_at IS NOT NULL) AND isfinite(hold_expires_at)) OR ((status <> 'held'::public.court_reservation_status) AND (hold_expires_at IS NULL)))), CONSTRAINT "court_reservation_cancellation_check" CHECK ((((status = ANY (ARRAY['active'::public.court_reservation_status, 'held'::public.court_reservation_status, 'released'::public.court_reservation_status])) AND (cancelled_at IS NULL) AND (cancelled_by_user_id IS NULL)) OR ((status = 'cancelled'::public.court_reservation_status) AND (cancelled_at IS NOT NULL) AND (cancelled_by_user_id IS NOT NULL)))), CONSTRAINT "adjustment_reservation_state" CHECK (adjustment_id IS NULL OR status IN ('held', 'released')), CONSTRAINT "court_reservation_coach_no_overlap" EXCLUDE USING gist (coach_user_id WITH =, booking_date WITH =, int4range(starts_at_minute, ends_at_minute, '[)') WITH &&) WHERE (coach_user_id IS NOT NULL AND status IN ('active', 'held')), CONSTRAINT "court_reservation_no_overlap" EXCLUDE USING gist (court_id WITH =, booking_date WITH =, int4range(starts_at_minute, ends_at_minute, '[)') WITH &&) WHERE (status IN ('active', 'held') AND occupies_court), CONSTRAINT "court_reservations_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "payment_holds_expiry_idx" ON "court_reservations"  ("court_id", "hold_expires_at") WHERE (status = 'held'::public.court_reservation_status)`);
        await queryRunner.query(`CREATE INDEX "court_reservations_personal_owner_idx" ON "court_reservations"  ("created_by_user_id") WHERE (created_by_user_id IS NOT NULL)`);
        await queryRunner.query(`CREATE INDEX "adjustment_reservations" ON "court_reservations"  ("adjustment_id") WHERE adjustment_id IS NOT NULL`);
        await queryRunner.query(`CREATE TYPE "public"."booking_status" AS ENUM('confirmed', 'cancelled', 'pending_payment', 'failed', 'expired')`);
        await queryRunner.query(`CREATE TABLE "checkout_records" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "reservation_id" uuid NOT NULL, "account_user_id" uuid, "current_revision_id" uuid NOT NULL, "status" "public"."booking_status" NOT NULL DEFAULT 'confirmed', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "bookings_reservation_id_key" UNIQUE ("reservation_id"), CONSTRAINT "bookings_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "bookings_account_user_id_idx" ON "checkout_records"  ("account_user_id") `);
        await queryRunner.query(`CREATE TABLE "coaching_programs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "name" text NOT NULL, "description" text NOT NULL, "program_type" text NOT NULL, "min_participants" integer, "max_participants" integer, "court_rental_included" boolean NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "coaching_programs_participants_check" CHECK ((min_participants IS NULL OR min_participants BETWEEN 1 AND 100) AND (max_participants IS NULL OR max_participants BETWEEN 1 AND 100) AND (min_participants IS NULL OR max_participants IS NULL OR min_participants <= max_participants)), CONSTRAINT "coaching_programs_description_check" CHECK (char_length(description) <= 2000), CONSTRAINT "coaching_programs_name_check" CHECK (char_length(btrim(name)) BETWEEN 1 AND 100), CONSTRAINT "coaching_programs_type_check" CHECK (program_type IN ('private', 'semi_private', 'group', 'junior')), CONSTRAINT "coaching_programs_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "booking_revisions" ("id" uuid NOT NULL, "booking_id" uuid NOT NULL, "revision_number" integer NOT NULL, "previous_revision_id" uuid, "operation_key" text NOT NULL, "intent_hash" text NOT NULL, "kind" text NOT NULL, "booking_state" text NOT NULL, "location_id" uuid NOT NULL, "court_id" uuid NOT NULL, "location_name" text NOT NULL, "court_name" text NOT NULL, "timezone" text NOT NULL, "booking_date" date NOT NULL, "starts_at_minute" integer NOT NULL, "ends_at_minute" integer NOT NULL, "customer_name" text NOT NULL, "customer_email" text NOT NULL, "customer_phone" text NOT NULL, "total_amount_minor" integer NOT NULL, "currency" text NOT NULL, "payment_method" text NOT NULL, "cancellation_notice_minutes" integer NOT NULL, "actor_user_id" uuid, "actor_scope" text NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL, "adjustment_id" uuid, "cancellation_cause" text, "pricing_evidence" jsonb NOT NULL, "coach_user_id" uuid, "coaching_program_id" uuid, "coach_name" text, "coaching_program_name" text, CONSTRAINT "booking_revisions_operation" UNIQUE ("booking_id", "operation_key"), CONSTRAINT "booking_revisions_predecessor" UNIQUE ("booking_id", "previous_revision_id"), CONSTRAINT "booking_revisions_number" UNIQUE ("booking_id", "revision_number"), CONSTRAINT "booking_revisions_identity" UNIQUE ("booking_id", "id"), CONSTRAINT "booking_revisions_operation_key" CHECK (char_length(operation_key) BETWEEN 1 AND 128 AND char_length(intent_hash) BETWEEN 1 AND 64), CONSTRAINT "booking_revisions_timestamp" CHECK (isfinite(recorded_at)), CONSTRAINT "booking_revisions_contact" CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 200 AND char_length(btrim(customer_email)) BETWEEN 1 AND 320 AND char_length(btrim(customer_phone)) BETWEEN 1 AND 50), CONSTRAINT "booking_revisions_method" CHECK (payment_method IN ('online','pay_at_club')), CONSTRAINT "booking_revisions_currency" CHECK (currency IN ('EUR','USD','GBP','RON','CHF')), CONSTRAINT "booking_revisions_evidence" CHECK (jsonb_typeof(pricing_evidence)='object' AND octet_length(pricing_evidence::text)<=20000), CONSTRAINT "booking_revisions_interval" CHECK (isfinite(booking_date) AND starts_at_minute>=0 AND ends_at_minute<=1440 AND starts_at_minute%30=0 AND ends_at_minute%30=0 AND ends_at_minute-starts_at_minute>=60), CONSTRAINT "booking_revisions_notice" CHECK (cancellation_notice_minutes BETWEEN 0 AND 43200), CONSTRAINT "booking_revisions_amount" CHECK (total_amount_minor > 0), CONSTRAINT "booking_revisions_cancellation" CHECK ((kind='cancelled' AND cancellation_cause IS NOT NULL AND cancellation_cause IN ('owner_cancelled','admin_cancelled','coach_cancelled','checkout_abandoned')) OR (kind<>'cancelled' AND cancellation_cause IS NULL)), CONSTRAINT "booking_revisions_scope" CHECK (actor_scope IN ('guest','customer','coach_owner','coach','admin_owner','admin','provider')), CONSTRAINT "booking_revisions_state" CHECK ((kind='created' AND booking_state IN ('pending_payment','confirmed')) OR (kind IN ('confirmed','rescheduled') AND booking_state='confirmed') OR (kind='cancelled' AND booking_state='cancelled')), CONSTRAINT "booking_revisions_first" CHECK ((revision_number=1 AND previous_revision_id IS NULL AND kind='created') OR (revision_number>1 AND previous_revision_id IS NOT NULL AND kind<>'created')), CONSTRAINT "booking_revisions_coaching" CHECK ((coach_user_id IS NULL AND coaching_program_id IS NULL AND coach_name IS NULL AND coaching_program_name IS NULL) OR (coach_user_id IS NOT NULL AND coaching_program_id IS NOT NULL AND coach_name IS NOT NULL AND coaching_program_name IS NOT NULL AND char_length(btrim(coach_name)) BETWEEN 1 AND 100 AND char_length(btrim(coaching_program_name)) BETWEEN 1 AND 100)), CONSTRAINT "booking_revisions_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "booking_revisions_adjustment" ON "booking_revisions"  ("adjustment_id") WHERE adjustment_id IS NOT NULL`);
        await queryRunner.query(`CREATE TABLE "payment_attempts" ("adjustment_id" uuid, "id" uuid NOT NULL DEFAULT gen_random_uuid(), "booking_id" uuid NOT NULL, "method" text NOT NULL, "provider" text, "provider_payment_id" text, "amount_minor" integer NOT NULL, "currency" text NOT NULL, "status" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, "checkout_token_hash" text, CONSTRAINT "payment_attempts_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'expired'::text, 'due'::text]))), CONSTRAINT "payment_attempts_provider_payment_id_check" CHECK (((char_length(provider_payment_id) >= 1) AND (char_length(provider_payment_id) <= 255))), CONSTRAINT "payment_attempts_provider_check" CHECK ((provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))), CONSTRAINT "payment_attempts_method_check" CHECK ((method = ANY (ARRAY['online'::text, 'pay_at_club'::text]))), CONSTRAINT "payment_attempts_currency_check" CHECK ((currency = ANY (ARRAY['EUR'::text, 'USD'::text, 'GBP'::text, 'RON'::text, 'CHF'::text]))), CONSTRAINT "payment_attempts_amount_minor_check" CHECK ((amount_minor > 0)), CONSTRAINT "payment_attempt_method_check" CHECK ((((method = 'online'::text) AND (provider IS NOT NULL) AND (status <> 'due'::text) AND (expires_at IS NOT NULL) AND isfinite(expires_at)) OR ((method = 'pay_at_club'::text) AND (provider IS NULL) AND (provider_payment_id IS NULL) AND (status = 'due'::text) AND (expires_at IS NULL)))), CONSTRAINT "payment_attempt_completion_check" CHECK ((((status = ANY (ARRAY['pending'::text, 'due'::text])) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text, 'expired'::text])) AND (completed_at IS NOT NULL)))), CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "payment_checkout_token_idx" ON "payment_attempts"  ("checkout_token_hash") WHERE (checkout_token_hash IS NOT NULL)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "payment_attempts_provider_id" ON "payment_attempts"  ("provider", "provider_payment_id") WHERE (provider_payment_id IS NOT NULL)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "payment_attempts_one_pending" ON "payment_attempts"  ("booking_id") WHERE (status = 'pending'::text)`);
        await queryRunner.query(`CREATE INDEX "payment_attempts_booking_idx" ON "payment_attempts"  ("booking_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "payment_attempts_one_adjustment" ON "payment_attempts"  ("adjustment_id") WHERE adjustment_id IS NOT NULL`);
        await queryRunner.query(`CREATE TABLE "payment_capture_receipts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "payment_attempt_id" uuid NOT NULL, "provider" text NOT NULL, "provider_payment_id" text NOT NULL, "provider_capture_id" text NOT NULL, "amount_minor" integer NOT NULL, "currency" text NOT NULL, "first_observed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), "last_observed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), CONSTRAINT "payment_capture_receipts_attempt_identity" UNIQUE ("payment_attempt_id", "id"), CONSTRAINT "payment_capture_receipts_observation_check" CHECK (isfinite(first_observed_at) AND isfinite(last_observed_at) AND last_observed_at >= first_observed_at), CONSTRAINT "payment_capture_receipts_identity_check" CHECK (char_length(provider_payment_id) BETWEEN 1 AND 255 AND char_length(provider_capture_id) BETWEEN 1 AND 255), CONSTRAINT "payment_capture_receipts_currency_check" CHECK (currency IN ('EUR','USD','GBP','RON','CHF')), CONSTRAINT "payment_capture_receipts_amount_check" CHECK (amount_minor > 0), CONSTRAINT "payment_capture_receipts_provider_check" CHECK (provider IN ('stripe','netopia')), CONSTRAINT "payment_capture_receipts_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "payment_capture_receipts_provider_capture" ON "payment_capture_receipts"  ("provider", "provider_capture_id") `);
        await queryRunner.query(`CREATE INDEX "payment_capture_receipts_attempt_idx" ON "payment_capture_receipts"  ("payment_attempt_id") `);
        await queryRunner.query(`CREATE TABLE "payment_provider_changes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "previous_provider" text, "active_provider" text, "changed_by_user_id" uuid NOT NULL, "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "payment_provider_changes_previous_provider_check" CHECK ((previous_provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))), CONSTRAINT "payment_provider_changes_active_provider_check" CHECK ((active_provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))), CONSTRAINT "payment_provider_changes_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "payment_provider_events" ("provider" text NOT NULL, "event_id" text NOT NULL, "attempt_id" uuid NOT NULL, "capture_receipt_id" uuid, "provider_payment_id" text NOT NULL, "outcome" text NOT NULL, "settlement_result" text NOT NULL, "reconciliation_required" boolean NOT NULL DEFAULT false, "amount_minor" integer NOT NULL, "currency" text NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), "resolved_at" TIMESTAMP WITH TIME ZONE, "resolved_by_user_id" uuid, CONSTRAINT "payment_provider_events_provider_check" CHECK ((provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))), CONSTRAINT "payment_provider_events_outcome_check" CHECK ((outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'retryable_failed'::text, 'cancelled'::text]))), CONSTRAINT "payment_event_capture_check" CHECK ((outcome='succeeded') = (capture_receipt_id IS NOT NULL)), CONSTRAINT "payment_event_resolution_check" CHECK ((((resolved_at IS NULL) AND (resolved_by_user_id IS NULL)) OR ((resolved_at IS NOT NULL) AND (NOT reconciliation_required)))), CONSTRAINT "payment_provider_events_pkey" PRIMARY KEY ("provider", "event_id"))`);
        await queryRunner.query(`CREATE INDEX "payment_reconciliation_idx" ON "payment_provider_events"  ("attempt_id") WHERE reconciliation_required`);
        await queryRunner.query(`CREATE TABLE "payment_provider_settings" ("id" boolean NOT NULL DEFAULT true, "active_provider" text, "updated_by_user_id" uuid, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "payment_provider_settings_id_check" CHECK (id), CONSTRAINT "payment_provider_settings_active_provider_check" CHECK ((active_provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))), CONSTRAINT "payment_provider_settings_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "club_settings" ("id" boolean NOT NULL DEFAULT true, "official_email" text NOT NULL DEFAULT '', "sender_name" text NOT NULL DEFAULT '', "emails_enabled" boolean NOT NULL DEFAULT false, "contact_email" text NOT NULL DEFAULT '', "contact_phone" text NOT NULL DEFAULT '', CONSTRAINT "club_settings_singleton" CHECK (id), CONSTRAINT "club_settings_sender" CHECK (NOT emails_enabled OR (length(trim(official_email)) > 0 AND length(trim(sender_name)) > 0)), CONSTRAINT "club_settings_contact" CHECK (length(contact_email) <= 254 AND length(contact_phone) <= 30), CONSTRAINT "club_settings_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "payment_refunds" ("reason" text NOT NULL, "context_revision_id" uuid NOT NULL, "adjustment_id" uuid, "operation_key" text NOT NULL DEFAULT 'cancellation', "captured_amount_minor" integer NOT NULL, "id" uuid NOT NULL DEFAULT gen_random_uuid(), "booking_id" uuid NOT NULL, "payment_attempt_id" uuid NOT NULL, "provider" text NOT NULL, "provider_payment_id" text NOT NULL, "amount_minor" integer NOT NULL, "currency" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "requested_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "payment_refunds_operation" UNIQUE ("payment_attempt_id", "operation_key"), CONSTRAINT "payment_refunds_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'pending_retry'::text, 'succeeded'::text, 'failed'::text, 'voided'::text]))), CONSTRAINT "payment_refunds_provider_check" CHECK ((provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))), CONSTRAINT "payment_refunds_amount_minor_check" CHECK ((amount_minor > 0)), CONSTRAINT "payment_refunds_captured_amount_minor_check" CHECK (captured_amount_minor > 0 AND amount_minor <= captured_amount_minor), CONSTRAINT "payment_refunds_reason_check" CHECK (reason IN ('booking_cancellation','booking_price_reduction','failed_adjustment_compensation','late_capture_compensation')), CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "payment_refunds_booking_idx" ON "payment_refunds"  ("booking_id") `);
        await queryRunner.query(`CREATE TABLE "refund_executions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "refund_id" uuid NOT NULL, "execution_number" integer NOT NULL, "provider" text NOT NULL, "provider_payment_id" text NOT NULL, "amount_minor" integer NOT NULL, "currency" text NOT NULL, "idempotency_key" text NOT NULL, "initiated_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "dispatch_initiated_at" TIMESTAMP WITH TIME ZONE, "provider_refund_id" text, "first_uncertain_at" TIMESTAMP WITH TIME ZONE, "first_uncertainty_evidence" text, "terminal_result" text, "terminal_evidence" text, "completed_at" TIMESTAMP WITH TIME ZONE, "status" text NOT NULL DEFAULT 'ready', "lease_token" uuid, "lease_until" TIMESTAMP WITH TIME ZONE, "last_checked_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "refund_executions_provider_refund_key" UNIQUE ("provider", "provider_refund_id"), CONSTRAINT "refund_executions_idempotency_key" UNIQUE ("provider", "idempotency_key"), CONSTRAINT "refund_executions_number_key" UNIQUE ("refund_id", "execution_number"), CONSTRAINT "refund_executions_time_check" CHECK (isfinite(created_at) AND isfinite(updated_at)
  AND (dispatch_initiated_at IS NULL OR isfinite(dispatch_initiated_at))
  AND (first_uncertain_at IS NULL OR isfinite(first_uncertain_at))
  AND (completed_at IS NULL OR isfinite(completed_at))
  AND (last_checked_at IS NULL OR isfinite(last_checked_at))), CONSTRAINT "refund_executions_provider_identity_check" CHECK (provider_refund_id IS NULL OR char_length(btrim(provider_refund_id)) > 0), CONSTRAINT "refund_executions_dispatch_check" CHECK ((status = 'ready' AND dispatch_initiated_at IS NULL
    AND provider_refund_id IS NULL AND first_uncertain_at IS NULL)
  OR (status <> 'ready' AND dispatch_initiated_at IS NOT NULL)), CONSTRAINT "refund_executions_terminal_check" CHECK (
  (terminal_result IS NULL AND terminal_evidence IS NULL AND completed_at IS NULL AND status IN ('ready', 'pending', 'uncertain'))
  OR (terminal_result IS NOT NULL AND terminal_result IN ('succeeded', 'failed', 'rejected')
    AND status = terminal_result AND terminal_evidence IS NOT NULL AND char_length(btrim(terminal_evidence)) > 0
    AND completed_at IS NOT NULL AND dispatch_initiated_at IS NOT NULL
    AND ((terminal_result = 'rejected' AND provider_refund_id IS NULL)
      OR (terminal_result IN ('succeeded', 'failed') AND provider_refund_id IS NOT NULL)))), CONSTRAINT "refund_executions_uncertainty_check" CHECK ((first_uncertain_at IS NULL) = (first_uncertainty_evidence IS NULL)
  AND (first_uncertainty_evidence IS NULL OR char_length(btrim(first_uncertainty_evidence)) > 0)
  AND (status <> 'uncertain' OR first_uncertain_at IS NOT NULL)), CONSTRAINT "refund_executions_lease_check" CHECK ((lease_token IS NULL) = (lease_until IS NULL) AND (lease_until IS NULL OR isfinite(lease_until))), CONSTRAINT "refund_executions_status_check" CHECK (status IN ('ready', 'pending', 'uncertain', 'succeeded', 'failed', 'rejected')), CONSTRAINT "refund_executions_request_check" CHECK (char_length(btrim(provider_payment_id)) > 0 AND char_length(btrim(idempotency_key)) > 0), CONSTRAINT "refund_executions_currency_check" CHECK (currency IN ('EUR', 'USD', 'GBP', 'RON', 'CHF')), CONSTRAINT "refund_executions_provider_check" CHECK (provider IN ('stripe', 'netopia')), CONSTRAINT "refund_executions_amount_check" CHECK (amount_minor > 0), CONSTRAINT "refund_executions_number_check" CHECK (execution_number > 0), CONSTRAINT "refund_executions_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "refund_executions_one_active" ON "refund_executions"  ("refund_id") WHERE status NOT IN ('failed', 'rejected')`);
        await queryRunner.query(`CREATE TABLE "court_coverage_periods" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "court_id" uuid NOT NULL, "starts_on" date NOT NULL, "ends_on" date NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "court_coverage_dates_check" CHECK (starts_on <= ends_on AND isfinite(starts_on) AND isfinite(ends_on)), CONSTRAINT "court_coverage_no_overlap" EXCLUDE USING gist (court_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&), CONSTRAINT "court_coverage_periods_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "opening_hours_schedules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "location_id" uuid NOT NULL, "starts_on" date NOT NULL, "ends_on" date, "revision" integer NOT NULL DEFAULT '1', CONSTRAINT "opening_hours_schedules_location_identity" UNIQUE ("location_id", "id"), CONSTRAINT "opening_hours_schedules_dates" CHECK (ends_on IS NULL OR starts_on <= ends_on), CONSTRAINT "opening_hours_schedules_no_overlap" EXCLUDE USING gist (location_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&), CONSTRAINT "opening_hours_schedules_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "location_opening_hours" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "location_id" uuid NOT NULL, "schedule_id" uuid NOT NULL, "weekday" integer NOT NULL, "opens_at_minute" integer NOT NULL, "closes_at_minute" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "location_opening_hours_weekday_check" CHECK (weekday >= 0 AND weekday <= 6), CONSTRAINT "location_opening_hours_positive_interval" CHECK (opens_at_minute < closes_at_minute), CONSTRAINT "location_opening_hours_opens_at_minute_check" CHECK (opens_at_minute >= 0 AND opens_at_minute <= 1439), CONSTRAINT "location_opening_hours_closes_at_minute_check" CHECK (closes_at_minute >= 1 AND closes_at_minute <= 1440), CONSTRAINT "location_opening_hours_no_overlap" EXCLUDE USING gist (schedule_id WITH =, weekday WITH =, int4range(opens_at_minute, closes_at_minute, '[)') WITH &&), CONSTRAINT "location_opening_hours_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "pricing_rule_sets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "location_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pricing_rule_sets_id_location_id_key" UNIQUE ("id", "location_id"), CONSTRAINT "pricing_rule_sets_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "location_pricing_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "location_id" uuid NOT NULL, "rule_set_id" uuid NOT NULL, "court_id" uuid NOT NULL, "court_state" text NOT NULL, "weekday" integer NOT NULL, "starts_at_minute" integer NOT NULL, "ends_at_minute" integer NOT NULL, "starts_on" date, "ends_on" date, "price_per_hour_minor" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "location_pricing_rules_weekday_check" CHECK (weekday >= 0 AND weekday <= 6), CONSTRAINT "location_pricing_rules_starts_at_minute_check" CHECK (starts_at_minute >= 0 AND starts_at_minute <= 1439), CONSTRAINT "location_pricing_rules_price_per_hour_minor_check" CHECK (price_per_hour_minor > 0), CONSTRAINT "location_pricing_rules_ends_at_minute_check" CHECK (ends_at_minute >= 1 AND ends_at_minute <= 1440), CONSTRAINT "location_pricing_rules_court_state_check" CHECK (court_state = ANY (ARRAY['outdoor'::text, 'covered'::text, 'indoor'::text])), CONSTRAINT "location_pricing_positive_interval" CHECK (starts_at_minute < ends_at_minute), CONSTRAINT "location_pricing_dates_check" CHECK ((starts_on IS NULL OR isfinite(starts_on)) AND (ends_on IS NULL OR isfinite(ends_on)) AND (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)), CONSTRAINT "location_pricing_no_overlap" EXCLUDE USING gist (court_id WITH =, court_state WITH =, weekday WITH =, daterange(starts_on, ends_on, '[]') WITH &&, int4range(starts_at_minute, ends_at_minute, '[)') WITH &&), CONSTRAINT "location_pricing_rules_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "location_pricing_rule_set_idx" ON "location_pricing_rules"  ("rule_set_id") `);
        await queryRunner.query(`CREATE TABLE "coach_locations" ("coach_user_id" uuid NOT NULL, "location_id" uuid NOT NULL, CONSTRAINT "coach_locations_pkey" PRIMARY KEY ("coach_user_id", "location_id"))`);
        await queryRunner.query(`CREATE TABLE "coach_programs" ("coach_user_id" uuid NOT NULL, "program_id" uuid NOT NULL, CONSTRAINT "coach_programs_pkey" PRIMARY KEY ("coach_user_id", "program_id"))`);
        await queryRunner.query(`CREATE TABLE "coach_availability_exceptions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "coach_user_id" uuid NOT NULL, "exception_date" date NOT NULL, "until_date" date NOT NULL, "kind" text NOT NULL, "location_id" uuid, "start_minute" integer, "end_minute" integer, "note" text NOT NULL DEFAULT '', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "coach_availability_exceptions_dates_check" CHECK (isfinite(exception_date) AND isfinite(until_date) AND exception_date <= until_date AND (exception_date = until_date OR (kind = 'unavailable' AND start_minute IS NULL AND end_minute IS NULL))), CONSTRAINT "coach_availability_exceptions_note_check" CHECK (char_length(note) <= 200), CONSTRAINT "coach_availability_exceptions_minutes_check" CHECK ((start_minute IS NULL AND end_minute IS NULL) OR (start_minute IS NOT NULL AND end_minute IS NOT NULL AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute AND start_minute % 30 = 0 AND end_minute % 30 = 0)), CONSTRAINT "coach_availability_exceptions_kind_check" CHECK ((kind = 'unavailable' AND location_id IS NULL) OR (kind = 'available' AND location_id IS NOT NULL AND start_minute IS NOT NULL)), CONSTRAINT "coach_availability_exceptions_no_overlap" EXCLUDE USING gist (coach_user_id WITH =, daterange(exception_date, until_date, '[]') WITH &&, int4range(COALESCE(start_minute, 0), COALESCE(end_minute, 1440), '[)') WITH &&), CONSTRAINT "coach_availability_exceptions_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "coach_weekly_availability" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "coach_user_id" uuid NOT NULL, "location_id" uuid NOT NULL, "weekday" integer NOT NULL, "start_minute" integer NOT NULL, "end_minute" integer NOT NULL, "valid_from" date NOT NULL, "valid_until" date, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "coach_weekly_availability_dates_check" CHECK (isfinite(valid_from) AND (valid_until IS NULL OR (isfinite(valid_until) AND valid_from <= valid_until))), CONSTRAINT "coach_weekly_availability_minutes_check" CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute AND start_minute % 30 = 0 AND end_minute % 30 = 0), CONSTRAINT "coach_weekly_availability_weekday_check" CHECK (weekday BETWEEN 0 AND 6), CONSTRAINT "coach_weekly_availability_no_overlap" EXCLUDE USING gist (coach_user_id WITH =, weekday WITH =, daterange(valid_from, valid_until, '[]') WITH &&, int4range(start_minute, end_minute, '[)') WITH &&), CONSTRAINT "coach_weekly_availability_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "coaching_program_durations" ("program_id" uuid NOT NULL, "duration_minutes" integer NOT NULL, CONSTRAINT "coaching_program_durations_minutes_check" CHECK (duration_minutes IN (60, 90, 120)), CONSTRAINT "coaching_program_durations_pkey" PRIMARY KEY ("program_id", "duration_minutes"))`);
        await queryRunner.query(`CREATE TABLE "coaching_prices" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "program_id" uuid NOT NULL, "duration_minutes" integer NOT NULL, "participant_count" integer NOT NULL, "coach_user_id" uuid, "amount_minor" integer NOT NULL, "currency" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "coaching_prices_currency_check" CHECK (currency IN ('EUR', 'USD', 'GBP', 'RON', 'CHF')), CONSTRAINT "coaching_prices_amount_check" CHECK (amount_minor > 0), CONSTRAINT "coaching_prices_participants_check" CHECK (participant_count BETWEEN 1 AND 100), CONSTRAINT "coaching_prices_pkey" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "coaching_prices_coach_override" ON "coaching_prices"  ("coach_user_id", "program_id", "duration_minutes", "participant_count", "currency") WHERE coach_user_id IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "coaching_prices_club_default" ON "coaching_prices"  ("program_id", "duration_minutes", "participant_count", "currency") WHERE coach_user_id IS NULL`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "player_profiles" ADD CONSTRAINT "player_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "roles"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_adjustments" ADD CONSTRAINT "booking_adjustments_base_revision_fkey" FOREIGN KEY ("booking_id", "base_revision_id") REFERENCES "booking_revisions"("booking_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_adjustments" ADD CONSTRAINT "booking_adjustments_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_adjustments" ADD CONSTRAINT "booking_adjustments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "checkout_records"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coach_profiles" ADD CONSTRAINT "coach_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "courts" ADD CONSTRAINT "courts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "court_reservations" ADD CONSTRAINT "court_reservations_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "coach_profiles"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "court_reservations" ADD CONSTRAINT "court_reservations_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "booking_adjustments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "court_reservations" ADD CONSTRAINT "court_reservations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "court_reservations" ADD CONSTRAINT "court_reservations_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "court_reservations" ADD CONSTRAINT "court_reservations_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "checkout_records" ADD CONSTRAINT "bookings_current_revision_fkey" FOREIGN KEY ("id", "current_revision_id") REFERENCES "booking_revisions"("booking_id","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`);
        await queryRunner.query(`ALTER TABLE "checkout_records" ADD CONSTRAINT "bookings_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "court_reservations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "checkout_records" ADD CONSTRAINT "bookings_account_user_id_fkey" FOREIGN KEY ("account_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_coaching_program_fkey" FOREIGN KEY ("coaching_program_id") REFERENCES "coaching_programs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_coach_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "coach_profiles"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_court_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_location_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_adjustment_fkey" FOREIGN KEY ("booking_id", "adjustment_id") REFERENCES "booking_adjustments"("booking_id","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_previous_fkey" FOREIGN KEY ("booking_id", "previous_revision_id") REFERENCES "booking_revisions"("booking_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_booking_fkey" FOREIGN KEY ("booking_id") REFERENCES "checkout_records"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "booking_adjustments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "checkout_records"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_capture_receipts" ADD CONSTRAINT "payment_capture_receipts_attempt_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_provider_changes" ADD CONSTRAINT "payment_provider_changes_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_capture_receipt_fkey" FOREIGN KEY ("attempt_id", "capture_receipt_id") REFERENCES "payment_capture_receipts"("payment_attempt_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_provider_settings" ADD CONSTRAINT "payment_provider_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "booking_adjustments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "checkout_records"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_context_revision_fkey" FOREIGN KEY ("booking_id", "context_revision_id") REFERENCES "booking_revisions"("booking_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`);
        await queryRunner.query(`ALTER TABLE "refund_executions" ADD CONSTRAINT "refund_executions_initiator_fkey" FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "refund_executions" ADD CONSTRAINT "refund_executions_refund_fkey" FOREIGN KEY ("refund_id") REFERENCES "payment_refunds"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "court_coverage_periods" ADD CONSTRAINT "court_coverage_periods_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "opening_hours_schedules" ADD CONSTRAINT "opening_hours_schedules_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "location_opening_hours" ADD CONSTRAINT "location_opening_hours_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "location_opening_hours" ADD CONSTRAINT "location_opening_hours_schedule_fkey" FOREIGN KEY ("location_id", "schedule_id") REFERENCES "opening_hours_schedules"("location_id","id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pricing_rule_sets" ADD CONSTRAINT "pricing_rule_sets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "location_pricing_rules" ADD CONSTRAINT "location_pricing_rules_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "location_pricing_rules" ADD CONSTRAINT "pricing_rule_set_fk" FOREIGN KEY ("rule_set_id", "location_id") REFERENCES "pricing_rule_sets"("id","location_id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "location_pricing_rules" ADD CONSTRAINT "location_pricing_rules_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coach_locations" ADD CONSTRAINT "coach_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coach_locations" ADD CONSTRAINT "coach_locations_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "coach_profiles"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coach_programs" ADD CONSTRAINT "coach_programs_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "coaching_programs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coach_programs" ADD CONSTRAINT "coach_programs_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "coach_profiles"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coach_availability_exceptions" ADD CONSTRAINT "coach_availability_exceptions_coach_location_fkey" FOREIGN KEY ("coach_user_id", "location_id") REFERENCES "coach_locations"("coach_user_id","location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coach_availability_exceptions" ADD CONSTRAINT "coach_availability_exceptions_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "coach_profiles"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coach_weekly_availability" ADD CONSTRAINT "coach_weekly_availability_coach_location_fkey" FOREIGN KEY ("coach_user_id", "location_id") REFERENCES "coach_locations"("coach_user_id","location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coaching_program_durations" ADD CONSTRAINT "coaching_program_durations_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "coaching_programs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coaching_prices" ADD CONSTRAINT "coaching_prices_coach_program_fkey" FOREIGN KEY ("coach_user_id", "program_id") REFERENCES "coach_programs"("coach_user_id","program_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "coaching_prices" ADD CONSTRAINT "coaching_prices_duration_fkey" FOREIGN KEY ("program_id", "duration_minutes") REFERENCES "coaching_program_durations"("program_id","duration_minutes") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        // Immutable financial exception facts (no entity; written through the repository's SQL).
        // References retain contact, schedule and amounts.
        await queryRunner.query(`CREATE TABLE "booking_financial_exceptions" ("event_key" text NOT NULL, "booking_id" uuid NOT NULL, "revision_id" uuid NOT NULL, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), "kind" text NOT NULL, "adjustment_id" uuid, "payment_attempt_id" uuid, "refund_id" uuid, CONSTRAINT "booking_financial_exceptions_check" CHECK (adjustment_id IS NOT NULL OR payment_attempt_id IS NOT NULL OR refund_id IS NOT NULL), CONSTRAINT "booking_financial_exceptions_kind_check" CHECK (kind IN ('cancellation_rejected', 'modification_rejected', 'refunded_modification_unapplied', 'surcharge_unapplied', 'late_capture', 'refund_failed', 'refund_unresolved', 'refund_reversed')), CONSTRAINT "booking_financial_exceptions_occurred_at_check" CHECK (isfinite(occurred_at)), CONSTRAINT "booking_financial_exceptions_pkey" PRIMARY KEY ("event_key"))`);
        await queryRunner.query(`CREATE INDEX "booking_financial_exceptions_booking" ON "booking_financial_exceptions" ("booking_id")`);
        await queryRunner.query(`ALTER TABLE "booking_financial_exceptions" ADD CONSTRAINT "booking_financial_exceptions_revision" FOREIGN KEY ("booking_id", "revision_id") REFERENCES "booking_revisions"("booking_id","id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_financial_exceptions" ADD CONSTRAINT "booking_financial_exceptions_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "booking_adjustments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_financial_exceptions" ADD CONSTRAINT "booking_financial_exceptions_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "booking_financial_exceptions" ADD CONSTRAINT "booking_financial_exceptions_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "payment_refunds"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        // Confirmation proof depends on the same-booking revision key. Checkout/revision
        // cycles retain their deferred FK and head validation semantics.
        await queryRunner.query(`CREATE TABLE public.bookings (
          id uuid CONSTRAINT confirmed_bookings_pkey PRIMARY KEY,
          confirmation_revision_id uuid NOT NULL,
          CONSTRAINT confirmed_booking_checkout_fkey FOREIGN KEY(id) REFERENCES public.checkout_records(id) ON DELETE RESTRICT,
          CONSTRAINT confirmed_booking_revision_fkey FOREIGN KEY(id,confirmation_revision_id)
            REFERENCES public.booking_revisions(booking_id,id) ON DELETE RESTRICT
        )`);

        // Integrity-only guards, expression indexes and required reference records.
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
        await queryRunner.query(`CREATE TRIGGER bookings_ownership_immutable BEFORE UPDATE OF account_user_id ON public.checkout_records
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
        SELECT current_revision_id INTO head FROM public.checkout_records WHERE id=NEW.booking_id FOR UPDATE;
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
        IF TG_TABLE_NAME='checkout_records' THEN booking:=NEW.id; ELSE booking:=NEW.booking_id; END IF;
        SELECT current_revision_id INTO head FROM public.checkout_records WHERE id=booking;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT id INTO latest FROM public.booking_revisions WHERE booking_id=booking ORDER BY revision_number DESC LIMIT 1;
        IF latest IS NULL OR head IS DISTINCT FROM latest THEN
          RAISE EXCEPTION 'Current revision must be the history head' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END; $$`);
        await queryRunner.query(`CREATE CONSTRAINT TRIGGER bookings_revision_head AFTER INSERT OR UPDATE OF current_revision_id ON public.checkout_records
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

    public async down(queryRunner: QueryRunner): Promise<void> {
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
        await queryRunner.query(`DROP TRIGGER bookings_ownership_immutable ON public.checkout_records`);
        await queryRunner.query(`DROP FUNCTION public.protect_booking_ownership()`);
        await queryRunner.query(`DROP TRIGGER booking_adjustments_immutable ON public.booking_adjustments`);
        await queryRunner.query(`DROP TRIGGER payment_refunds_immutable ON public.payment_refunds`);
        await queryRunner.query(`DROP FUNCTION public.protect_financial_context()`);
        await queryRunner.query(`DROP TRIGGER bookings_revision_head ON public.checkout_records`);
        for (const name of ["booking_revisions_head", "booking_revisions_linear", "booking_revisions_immutable", "booking_revisions_no_truncate"]) {
          await queryRunner.query(`DROP TRIGGER ${name} ON public.booking_revisions`);
        }
        for (const name of ["validate_booking_revision_head", "validate_booking_revision_append", "protect_booking_revision"]) {
          await queryRunner.query(`DROP FUNCTION public.${name}()`);
        }
        await queryRunner.query(`DROP TABLE public.bookings`);
        await queryRunner.query(`DROP TABLE "email_deliveries"`);
        await queryRunner.query(`DROP TABLE "user_messages"`);
        await queryRunner.query(`DROP TABLE "booking_financial_exceptions"`);
        await queryRunner.query(`ALTER TABLE "coaching_prices" DROP CONSTRAINT "coaching_prices_duration_fkey"`);
        await queryRunner.query(`ALTER TABLE "coaching_prices" DROP CONSTRAINT "coaching_prices_coach_program_fkey"`);
        await queryRunner.query(`ALTER TABLE "coaching_program_durations" DROP CONSTRAINT "coaching_program_durations_program_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "coach_weekly_availability" DROP CONSTRAINT "coach_weekly_availability_coach_location_fkey"`);
        await queryRunner.query(`ALTER TABLE "coach_availability_exceptions" DROP CONSTRAINT "coach_availability_exceptions_coach_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "coach_availability_exceptions" DROP CONSTRAINT "coach_availability_exceptions_coach_location_fkey"`);
        await queryRunner.query(`ALTER TABLE "coach_programs" DROP CONSTRAINT "coach_programs_coach_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "coach_programs" DROP CONSTRAINT "coach_programs_program_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "coach_locations" DROP CONSTRAINT "coach_locations_coach_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "coach_locations" DROP CONSTRAINT "coach_locations_location_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "location_pricing_rules" DROP CONSTRAINT "location_pricing_rules_court_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "location_pricing_rules" DROP CONSTRAINT "pricing_rule_set_fk"`);
        await queryRunner.query(`ALTER TABLE "location_pricing_rules" DROP CONSTRAINT "location_pricing_rules_location_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "pricing_rule_sets" DROP CONSTRAINT "pricing_rule_sets_location_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "location_opening_hours" DROP CONSTRAINT "location_opening_hours_schedule_fkey"`);
        await queryRunner.query(`ALTER TABLE "location_opening_hours" DROP CONSTRAINT "location_opening_hours_location_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "opening_hours_schedules" DROP CONSTRAINT "opening_hours_schedules_location_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "court_coverage_periods" DROP CONSTRAINT "court_coverage_periods_court_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "refund_executions" DROP CONSTRAINT "refund_executions_refund_fkey"`);
        await queryRunner.query(`ALTER TABLE "refund_executions" DROP CONSTRAINT "refund_executions_initiator_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_context_revision_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_booking_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_payment_attempt_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_requested_by_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_adjustment_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_provider_settings" DROP CONSTRAINT "payment_provider_settings_updated_by_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_provider_events" DROP CONSTRAINT "payment_provider_events_attempt_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_provider_events" DROP CONSTRAINT "payment_provider_events_capture_receipt_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_provider_events" DROP CONSTRAINT "payment_provider_events_resolved_by_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_provider_changes" DROP CONSTRAINT "payment_provider_changes_changed_by_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_capture_receipts" DROP CONSTRAINT "payment_capture_receipts_attempt_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_booking_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_adjustment_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" DROP CONSTRAINT "booking_revisions_booking_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" DROP CONSTRAINT "booking_revisions_previous_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" DROP CONSTRAINT "booking_revisions_adjustment_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" DROP CONSTRAINT "booking_revisions_actor_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" DROP CONSTRAINT "booking_revisions_location_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" DROP CONSTRAINT "booking_revisions_court_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" DROP CONSTRAINT "booking_revisions_coach_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_revisions" DROP CONSTRAINT "booking_revisions_coaching_program_fkey"`);
        await queryRunner.query(`ALTER TABLE "checkout_records" DROP CONSTRAINT "bookings_account_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "checkout_records" DROP CONSTRAINT "bookings_reservation_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "checkout_records" DROP CONSTRAINT "bookings_current_revision_fkey"`);
        await queryRunner.query(`ALTER TABLE "court_reservations" DROP CONSTRAINT "court_reservations_cancelled_by_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "court_reservations" DROP CONSTRAINT "court_reservations_court_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "court_reservations" DROP CONSTRAINT "court_reservations_created_by_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "court_reservations" DROP CONSTRAINT "court_reservations_adjustment_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "court_reservations" DROP CONSTRAINT "court_reservations_coach_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "courts" DROP CONSTRAINT "courts_location_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "coach_profiles" DROP CONSTRAINT "coach_profiles_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_adjustments" DROP CONSTRAINT "booking_adjustments_booking_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_adjustments" DROP CONSTRAINT "booking_adjustments_actor_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "booking_adjustments" DROP CONSTRAINT "booking_adjustments_base_revision_fkey"`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_assigned_by_fkey"`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_role_code_fkey"`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "player_profiles" DROP CONSTRAINT "player_profiles_user_id_fkey"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "users_id_fkey"`);
        await queryRunner.query(`DROP INDEX "public"."coaching_prices_club_default"`);
        await queryRunner.query(`DROP INDEX "public"."coaching_prices_coach_override"`);
        await queryRunner.query(`DROP TABLE "coaching_prices"`);
        await queryRunner.query(`DROP TABLE "coaching_program_durations"`);
        await queryRunner.query(`DROP TABLE "coach_weekly_availability"`);
        await queryRunner.query(`DROP TABLE "coach_availability_exceptions"`);
        await queryRunner.query(`DROP TABLE "coach_programs"`);
        await queryRunner.query(`DROP TABLE "coach_locations"`);
        await queryRunner.query(`DROP INDEX "public"."location_pricing_rule_set_idx"`);
        await queryRunner.query(`DROP TABLE "location_pricing_rules"`);
        await queryRunner.query(`DROP TABLE "pricing_rule_sets"`);
        await queryRunner.query(`DROP TABLE "location_opening_hours"`);
        await queryRunner.query(`DROP TABLE "opening_hours_schedules"`);
        await queryRunner.query(`DROP TABLE "court_coverage_periods"`);
        await queryRunner.query(`DROP INDEX "public"."refund_executions_one_active"`);
        await queryRunner.query(`DROP TABLE "refund_executions"`);
        await queryRunner.query(`DROP INDEX "public"."payment_refunds_booking_idx"`);
        await queryRunner.query(`DROP TABLE "payment_refunds"`);
        await queryRunner.query(`DROP TABLE "club_settings"`);
        await queryRunner.query(`DROP TABLE "payment_provider_settings"`);
        await queryRunner.query(`DROP INDEX "public"."payment_reconciliation_idx"`);
        await queryRunner.query(`DROP TABLE "payment_provider_events"`);
        await queryRunner.query(`DROP TABLE "payment_provider_changes"`);
        await queryRunner.query(`DROP INDEX "public"."payment_capture_receipts_attempt_idx"`);
        await queryRunner.query(`DROP INDEX "public"."payment_capture_receipts_provider_capture"`);
        await queryRunner.query(`DROP TABLE "payment_capture_receipts"`);
        await queryRunner.query(`DROP INDEX "public"."payment_attempts_one_adjustment"`);
        await queryRunner.query(`DROP INDEX "public"."payment_attempts_booking_idx"`);
        await queryRunner.query(`DROP INDEX "public"."payment_attempts_one_pending"`);
        await queryRunner.query(`DROP INDEX "public"."payment_attempts_provider_id"`);
        await queryRunner.query(`DROP INDEX "public"."payment_checkout_token_idx"`);
        await queryRunner.query(`DROP TABLE "payment_attempts"`);
        await queryRunner.query(`DROP INDEX "public"."booking_revisions_adjustment"`);
        await queryRunner.query(`DROP TABLE "booking_revisions"`);
        await queryRunner.query(`DROP TABLE "coaching_programs"`);
        await queryRunner.query(`DROP INDEX "public"."bookings_account_user_id_idx"`);
        await queryRunner.query(`DROP TABLE "checkout_records"`);
        await queryRunner.query(`DROP TYPE "public"."booking_status"`);
        await queryRunner.query(`DROP INDEX "public"."adjustment_reservations"`);
        await queryRunner.query(`DROP INDEX "public"."court_reservations_personal_owner_idx"`);
        await queryRunner.query(`DROP INDEX "public"."payment_holds_expiry_idx"`);
        await queryRunner.query(`DROP TABLE "court_reservations"`);
        await queryRunner.query(`DROP TYPE "public"."court_reservation_status"`);
        await queryRunner.query(`DROP TABLE "courts"`);
        await queryRunner.query(`DROP TABLE "coach_profiles"`);
        await queryRunner.query(`DROP INDEX "public"."booking_adjustments_pending"`);
        await queryRunner.query(`DROP TABLE "booking_adjustments"`);
        await queryRunner.query(`DROP TABLE "locations"`);
        await queryRunner.query(`DROP INDEX "public"."user_roles_role_code_idx"`);
        await queryRunner.query(`DROP TABLE "user_roles"`);
        await queryRunner.query(`DROP TABLE "roles"`);
        await queryRunner.query(`DROP TABLE "player_profiles"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."user_status"`);
    }

}
