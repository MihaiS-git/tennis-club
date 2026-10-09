import "server-only";

import { Check, Column, Entity, JoinColumn, OneToOne, PrimaryColumn, type Relation } from "typeorm";

import { UserEntity } from "./user.entity";

@Entity({ schema: "public", name: "player_profiles" })
@Check("player_profiles_backhand_check", "backhand = ANY (ARRAY['one_handed'::text, 'two_handed'::text])")
@Check("player_profiles_handedness_check", "handedness = ANY (ARRAY['right'::text, 'left'::text])")
@Check("player_profiles_preferred_game_check", "preferred_game = ANY (ARRAY['singles'::text, 'doubles'::text, 'both'::text])")
@Check("player_profiles_preferred_surface_check", "preferred_surface = ANY (ARRAY['clay'::text, 'hard'::text, 'grass'::text, 'carpet'::text, 'any'::text])")
export class PlayerProfileEntity {
  @PrimaryColumn({ name: "user_id", type: "uuid", primaryKeyConstraintName: "player_profiles_pkey" })
  userId!: string;

  @Column({ name: "display_name", type: "text", nullable: true })
  displayName!: string | null;

  @Column({ name: "avatar_path", type: "text", nullable: true })
  avatarPath!: string | null;

  @Column({ name: "sportya_level", type: "text", nullable: true })
  sportyaLevel!: string | null;

  @Column({ name: "rating", type: "integer", nullable: true })
  rating!: number | null;

  @Column({ name: "handedness", type: "text", nullable: true })
  handedness!: "right" | "left" | null;

  @Column({ name: "backhand", type: "text", nullable: true })
  backhand!: "one_handed" | "two_handed" | null;

  @Column({ name: "preferred_game", type: "text", nullable: true })
  preferredGame!: "singles" | "doubles" | "both" | null;

  @Column({ name: "preferred_surface", type: "text", nullable: true })
  preferredSurface!: "clay" | "hard" | "grass" | "carpet" | "any" | null;

  @Column({ name: "bio", type: "text", nullable: true })
  bio!: string | null;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @OneToOne(() => UserEntity, { nullable: false, onDelete: "NO ACTION" })
  @JoinColumn({ name: "user_id", referencedColumnName: "id", foreignKeyConstraintName: "player_profiles_user_id_fkey" })
  user!: Relation<UserEntity>;
}
