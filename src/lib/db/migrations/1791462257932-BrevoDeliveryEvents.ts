import type { MigrationInterface, QueryRunner } from "typeorm";

export class BrevoDeliveryEvents1791462257932 implements MigrationInterface {
  name = "BrevoDeliveryEvents1791462257932";
  async up(queryRunner: QueryRunner): Promise<void> {
    // Provider evidence for the current submission of a delivery. submission_key
    // (NULL = the row id) is the Brevo idempotency key and X-Mailin-custom value;
    // it changes only when a new submission follows a reported delivery failure.
    await queryRunner.query(`ALTER TABLE public.booking_notification_deliveries
      ADD COLUMN submission_key uuid, ADD COLUMN provider_message_id text,
      ADD COLUMN provider_status text, ADD COLUMN provider_event text,
      ADD COLUMN provider_reason text, ADD COLUMN provider_event_at timestamptz,
      ADD CONSTRAINT booking_notification_deliveries_provider_status_check
        CHECK (provider_status IN ('deferred','delivered','failed')),
      ADD CONSTRAINT booking_notification_deliveries_provider_event_check
        CHECK ((provider_status IS NULL) = (provider_event IS NULL) AND (provider_status IS NULL) = (provider_event_at IS NULL)
          AND (provider_status IS NULL OR (provider_status = 'failed') = (delivered_at IS NULL)))`);
    await queryRunner.query(`CREATE UNIQUE INDEX booking_notification_deliveries_provider_message
      ON public.booking_notification_deliveries(provider_message_id) WHERE provider_message_id IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX booking_notification_deliveries_submission
      ON public.booking_notification_deliveries(submission_key) WHERE submission_key IS NOT NULL`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.booking_notification_deliveries
      WHERE provider_message_id IS NOT NULL OR provider_status IS NOT NULL OR submission_key IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot discard recorded Brevo delivery evidence'; END IF; END $$`);
    await queryRunner.query(`DROP INDEX public.booking_notification_deliveries_submission`);
    await queryRunner.query(`DROP INDEX public.booking_notification_deliveries_provider_message`);
    await queryRunner.query(`ALTER TABLE public.booking_notification_deliveries
      DROP CONSTRAINT booking_notification_deliveries_provider_event_check,
      DROP CONSTRAINT booking_notification_deliveries_provider_status_check,
      DROP COLUMN provider_event_at, DROP COLUMN provider_reason, DROP COLUMN provider_event,
      DROP COLUMN provider_status, DROP COLUMN provider_message_id, DROP COLUMN submission_key`);
  }
}
