import "server-only";

import { Check, Column, Entity, ForeignKey, PrimaryColumn } from "typeorm";
import type { PaymentProvider } from "@/lib/payments/domain";

import { UserEntity } from "./user.entity";

@Entity({ schema: "public", name: "payment_provider_changes" })
@Check("payment_provider_changes_active_provider_check", "(active_provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))")
@Check("payment_provider_changes_previous_provider_check", "(previous_provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))")
@ForeignKey(() => UserEntity, ["changedByUserId"], ["id"], { name: "payment_provider_changes_changed_by_user_id_fkey", onDelete: "RESTRICT" })
export class PaymentProviderChangeEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "payment_provider_changes_pkey" })
  id!: string;

  @Column({ name: "previous_provider", type: "text", nullable: true })
  previousProvider!: PaymentProvider | null;

  @Column({ name: "active_provider", type: "text", nullable: true })
  activeProvider!: PaymentProvider | null;

  @Column({ name: "changed_by_user_id", type: "uuid" })
  changedByUserId!: string;

  @Column({ name: "changed_at", type: "timestamptz", default: () => "now()" })
  changedAt!: Date;
}
