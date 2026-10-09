import "server-only";

import { Check, Column, Entity, ForeignKey, PrimaryColumn } from "typeorm";
import type { PaymentProvider } from "@/lib/payments/domain";

import { UserEntity } from "./user.entity";

@Entity({ schema: "public", name: "payment_provider_settings" })
@Check("payment_provider_settings_active_provider_check", "(active_provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))")
@Check("payment_provider_settings_id_check", "id")
@ForeignKey(() => UserEntity, ["updatedByUserId"], ["id"], { name: "payment_provider_settings_updated_by_user_id_fkey", onDelete: "RESTRICT" })
export class PaymentProviderSettingEntity {
  @PrimaryColumn({ name: "id", type: "boolean", default: true, primaryKeyConstraintName: "payment_provider_settings_pkey" })
  id!: boolean;

  @Column({ name: "active_provider", type: "text", nullable: true })
  activeProvider!: PaymentProvider | null;

  @Column({ name: "updated_by_user_id", type: "uuid", nullable: true })
  updatedByUserId!: string | null;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
