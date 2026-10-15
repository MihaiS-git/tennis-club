import "server-only";

import { Entity, PrimaryColumn } from "typeorm";

// Supabase owns this table. Metadata exists only to describe the application FK;
// TypeORM must never generate or synchronize Auth infrastructure.
@Entity({ schema: "auth", name: "users", synchronize: false })
export class AuthUserEntity {
  @PrimaryColumn({ type: "uuid" })
  id!: string;
}
