import "server-only";

import { Column, Entity, ForeignKey, Index, PrimaryColumn, Unique } from "typeorm";
import { UserEntity } from "./user.entity";

@Entity({ schema: "public", name: "user_messages" })
@Unique("user_messages_user_event_key", ["userId", "eventKey"])
@Index("user_messages_newest_idx", { synchronize: false })
@Index("user_messages_unread_idx", ["userId"], { where: "read_at IS NULL AND deleted_at IS NULL" })
@ForeignKey(() => UserEntity, ["userId"], ["id"], { name: "user_messages_user_id_fkey", onDelete: "CASCADE" })
export class UserMessageEntity {
  @PrimaryColumn({ type: "uuid", primaryKeyConstraintName: "user_messages_pkey" })
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ name: "event_key", type: "text" })
  eventKey!: string;

  @Column({ type: "text" })
  kind!: string;

  @Column({ type: "text" })
  subject!: string;

  @Column({ name: "body_text", type: "text" })
  bodyText!: string;

  @Column({ type: "text", nullable: true })
  href!: string | null;

  @Column({ name: "read_at", type: "timestamptz", nullable: true })
  readAt!: Date | null;

  @Column({ name: "deleted_at", type: "timestamptz", nullable: true })
  deletedAt!: Date | null;

  @Column({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
