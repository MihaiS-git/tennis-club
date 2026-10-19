import "server-only";

import { Check, Column, Entity, ForeignKey, PrimaryColumn } from "typeorm";

import { UserEntity } from "./user.entity";

// Public coaching profile, a sibling of player_profiles. It does not grant the
// coach role: public visibility also requires an active account holding it.
@Entity({ schema: "public", name: "coach_profiles" })
@ForeignKey(() => UserEntity, ["userId"], ["id"], { name: "coach_profiles_user_id_fkey", onDelete: "NO ACTION" })
@Check("coach_profiles_display_name_check", "char_length(btrim(display_name)) BETWEEN 1 AND 100")
@Check("coach_profiles_text_check", "char_length(bio) <= 2000 AND char_length(qualifications) <= 1000")
@Check("coach_profiles_lists_check", "cardinality(specialties) <= 12 AND cardinality(languages) <= 12")
export class CoachProfileEntity {
  @PrimaryColumn({ name: "user_id", type: "uuid", primaryKeyConstraintName: "coach_profiles_pkey" })
  userId!: string;

  @Column({ name: "display_name", type: "text" })
  displayName!: string;

  @Column({ name: "bio", type: "text" })
  bio!: string;

  @Column({ name: "qualifications", type: "text" })
  qualifications!: string;

  @Column({ name: "specialties", type: "text", array: true })
  specialties!: string[];

  @Column({ name: "languages", type: "text", array: true })
  languages!: string[];

  @Column({ name: "is_public", type: "boolean", default: false })
  isPublic!: boolean;

  @Column({ name: "archived_at", type: "timestamptz", nullable: true })
  archivedAt!: Date | null;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
