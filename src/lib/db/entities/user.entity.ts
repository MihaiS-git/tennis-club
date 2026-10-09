import "server-only";

import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ schema: "public", name: "users" })
// Expression index UNIQUE (lower(email)) requires explicit SQL in a TypeORM migration.
@Index("users_email_lower_unique", { synchronize: false })
export class UserEntity {
  // users_id_fkey -> auth.users(id) ON DELETE RESTRICT requires explicit migration SQL.
  // Supabase owns auth.users; it is not an application entity.
  @PrimaryColumn({ name: "id", type: "uuid", primaryKeyConstraintName: "users_pkey" })
  id!: string;

  @Column({ name: "email", type: "text" })
  email!: string;

  @Column({
    name: "status",
    type: "enum",
    enumName: "user_status",
    enum: ["active", "suspended"],
    default: "active",
  })
  status!: "active" | "suspended";

  @Column({ name: "first_name", type: "text", nullable: true })
  firstName!: string | null;

  @Column({ name: "last_name", type: "text", nullable: true })
  lastName!: string | null;

  @Column({ name: "phone", type: "text", nullable: true })
  phone!: string | null;

  @Column({ name: "date_of_birth", type: "date", nullable: true })
  dateOfBirth!: string | null;

  @Column({ name: "address_line1", type: "text", nullable: true })
  addressLine1!: string | null;

  @Column({ name: "address_line2", type: "text", nullable: true })
  addressLine2!: string | null;

  @Column({ name: "city", type: "text", nullable: true })
  city!: string | null;

  @Column({ name: "postal_code", type: "text", nullable: true })
  postalCode!: string | null;

  @Column({ name: "country_code", type: "char", length: 2, nullable: true })
  countryCode!: string | null;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
