import "server-only";

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from "typeorm";

import { RoleEntity } from "./role.entity";
import { UserEntity } from "./user.entity";

@Entity({ schema: "public", name: "user_roles" })
@Index("user_roles_role_code_idx", ["roleCode"])
export class UserRoleEntity {
  @PrimaryColumn({ name: "user_id", type: "uuid", primaryKeyConstraintName: "user_roles_pkey" })
  userId!: string;

  @PrimaryColumn({ name: "role_code", type: "text", primaryKeyConstraintName: "user_roles_pkey" })
  roleCode!: string;

  @Column({ name: "assigned_at", type: "timestamptz", default: () => "now()" })
  assignedAt!: Date;

  @Column({ name: "assigned_by", type: "uuid", nullable: true })
  assignedBy!: string | null;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id", referencedColumnName: "id", foreignKeyConstraintName: "user_roles_user_id_fkey" })
  user!: Relation<UserEntity>;

  @ManyToOne(() => RoleEntity, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "role_code", referencedColumnName: "code", foreignKeyConstraintName: "user_roles_role_code_fkey" })
  role!: Relation<RoleEntity>;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "assigned_by", referencedColumnName: "id", foreignKeyConstraintName: "user_roles_assigned_by_fkey" })
  assignedByUser!: Relation<UserEntity> | null;
}
