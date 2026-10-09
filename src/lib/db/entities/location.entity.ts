import "server-only";

import { Check, Column, Entity, PrimaryColumn, Unique } from "typeorm";
import type { LocationCurrency } from "@/lib/pricing/money";

@Entity({ schema: "public", name: "locations" })
@Unique("locations_slug_key", ["slug"])
@Check("locations_archived_inactive_check", "archived_at IS NULL OR NOT is_active")
@Check("locations_currency_check", "currency = ANY (ARRAY['EUR'::text, 'USD'::text, 'GBP'::text, 'RON'::text, 'CHF'::text])")
@Check("locations_customer_cancellation_notice_check", "customer_cancellation_notice_minutes >= 0 AND customer_cancellation_notice_minutes <= 43200")
export class LocationEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "locations_pkey" })
  id!: string;

  @Column({ name: "name", type: "text" })
  name!: string;

  @Column({ name: "slug", type: "text" })
  slug!: string;

  @Column({ name: "address_line1", type: "text", nullable: true })
  addressLine1!: string | null;

  @Column({ name: "address_line2", type: "text", nullable: true })
  addressLine2!: string | null;

  @Column({ name: "city", type: "text", nullable: true })
  city!: string | null;

  @Column({ name: "postal_code", type: "text", nullable: true })
  postalCode!: string | null;

  @Column({ name: "country_code", type: "text", nullable: true })
  countryCode!: string | null;

  @Column({ name: "timezone", type: "text" })
  timezone!: string;

  @Column({ name: "currency", type: "text", default: "EUR" })
  currency!: LocationCurrency;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "archived_at", type: "timestamptz", nullable: true })
  archivedAt!: Date | null;

  @Column({ name: "display_order", type: "integer", default: 0 })
  displayOrder!: number;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @Column({ name: "is_public", type: "boolean", default: false })
  isPublic!: boolean;

  @Column({ name: "customer_cancellation_notice_minutes", type: "integer", default: 1440 })
  customerCancellationNoticeMinutes!: number;

  @Column({ name: "allow_pay_at_club", type: "boolean", default: false })
  allowPayAtClub!: boolean;
}
