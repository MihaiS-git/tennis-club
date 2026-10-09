import "server-only";

import { Check, Entity, PrimaryColumn } from "typeorm";

@Entity({ schema: "public", name: "roles" })
@Check("roles_code_format", "code ~ '^[a-z][a-z0-9_]*$'::text")
export class RoleEntity {
  @PrimaryColumn({ name: "code", type: "text", primaryKeyConstraintName: "roles_pkey" })
  code!: string;
}
