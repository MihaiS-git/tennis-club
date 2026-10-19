import type { MigrationInterface, QueryRunner } from "typeorm";

export class AdminNotificationDismissal1791462257933 implements MigrationInterface {
  name = "AdminNotificationDismissal1791462257933";
  async up(queryRunner: QueryRunner): Promise<void> {
    // An Admin dismissal of a financial email row. The row stays because it also
    // carries the customer's acknowledgement; only Admin email management ignores it.
    await queryRunner.query(`ALTER TABLE public.booking_notification_deliveries
      ADD COLUMN dismissed_at timestamptz,
      ADD CONSTRAINT booking_notification_deliveries_dismissed_check
        CHECK (dismissed_at IS NULL OR requires_acknowledgement)`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.booking_notification_deliveries
      DROP CONSTRAINT booking_notification_deliveries_dismissed_check, DROP COLUMN dismissed_at`);
  }
}
