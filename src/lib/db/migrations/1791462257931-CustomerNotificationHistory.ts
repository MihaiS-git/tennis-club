import type { MigrationInterface, QueryRunner } from "typeorm";

export class CustomerNotificationHistory1791462257931 implements MigrationInterface {
  name = "CustomerNotificationHistory1791462257931";
  async up(queryRunner: QueryRunner): Promise<void> {
    // No delivery FK: Admin deletion must never cascade into customer history.
    await queryRunner.query(`CREATE TABLE public.customer_notifications (
      id uuid PRIMARY KEY, event_key text NOT NULL UNIQUE,
      account_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
      event_kind text NOT NULL, subject text NOT NULL, text text NOT NULL,
      created_at timestamptz NOT NULL, read_at timestamptz, deleted_at timestamptz,
      requires_acknowledgement boolean NOT NULL, acknowledged_at timestamptz,
      CHECK (acknowledged_at IS NULL OR requires_acknowledgement))`);
    await queryRunner.query(`CREATE INDEX customer_notifications_owner_created
      ON public.customer_notifications(account_user_id,created_at DESC,id DESC)`);
    await queryRunner.query(`REVOKE ALL ON public.customer_notifications FROM PUBLIC, anon, authenticated`);
    // Recover existing history, including financial acknowledgement timestamps.
    // Older delivery records did not store kinds; their stable subjects and revision causes identify them.
    await queryRunner.query(`INSERT INTO public.customer_notifications
      (id,event_key,account_user_id,booking_id,event_kind,subject,text,created_at,read_at,requires_acknowledgement,acknowledged_at)
      SELECT d.id,d.event_key,b.account_user_id,b.id,
        CASE d.message->>'subject'
          WHEN 'Booking confirmed' THEN 'confirmed'
          WHEN 'Booking cancelled' THEN CASE WHEN r.cancellation_cause='admin_cancelled'
            OR d.message->>'text' LIKE '%The club administrator has cancelled%' THEN 'admin_cancelled' ELSE 'customer_cancelled' END
          WHEN 'Booking rescheduled' THEN 'customer_rescheduled'
          WHEN 'Booking cancellation not completed' THEN 'cancellation_failed'
          WHEN 'Booking change not completed' THEN 'modification_failed'
          WHEN 'Refund requires attention' THEN 'refund_incomplete'
          WHEN 'Payment received after checkout ended' THEN 'late_payment_refund'
          ELSE 'legacy_booking_email' END,
        d.message->>'subject',d.message->>'text',d.created_at,d.acknowledged_at,d.requires_acknowledgement,d.acknowledged_at
      FROM public.booking_notification_deliveries d JOIN public.bookings b ON b.id=d.booking_id
      LEFT JOIN public.booking_revisions r ON d.event_key='revision:' || r.id::text
      WHERE b.account_user_id IS NOT NULL`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.customer_notifications) THEN
      RAISE EXCEPTION 'Cannot discard customer notification history'; END IF; END $$`);
    await queryRunner.query(`DROP TABLE public.customer_notifications`);
  }
}
