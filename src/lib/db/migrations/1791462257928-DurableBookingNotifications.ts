import type { MigrationInterface, QueryRunner } from "typeorm";

export class DurableBookingNotifications1791462257928 implements MigrationInterface {
  name = "DurableBookingNotifications1791462257928";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE public.booking_notification_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_key text NOT NULL UNIQUE,
      message jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      delivered_at timestamptz, lease_token uuid, lease_until timestamptz,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
      CHECK ((lease_token IS NULL) = (lease_until IS NULL)))`);
    await queryRunner.query(`CREATE INDEX booking_notification_deliveries_due ON public.booking_notification_deliveries(next_attempt_at) WHERE delivered_at IS NULL`);
    await queryRunner.query(`REVOKE ALL ON public.booking_notification_deliveries FROM PUBLIC, anon, authenticated`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.booking_notification_deliveries) THEN
      RAISE EXCEPTION 'Cannot discard durable customer notification history'; END IF; END $$`);
    await queryRunner.query(`DROP TABLE public.booking_notification_deliveries`);
  }
}
