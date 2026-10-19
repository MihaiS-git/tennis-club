import "server-only";

import { Check, Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import type { CoachingProgramType } from "@/lib/coaching/validation";

// An Admin-configured coaching offering. Programs are deactivated, never deleted.
@Entity({ schema: "public", name: "coaching_programs" })
@Check("coaching_programs_type_check", "program_type IN ('private', 'semi_private', 'group', 'junior')")
@Check("coaching_programs_name_check", "char_length(btrim(name)) BETWEEN 1 AND 100")
@Check("coaching_programs_description_check", "char_length(description) <= 2000")
@Check("coaching_programs_participants_check", "(min_participants IS NULL OR min_participants BETWEEN 1 AND 100) AND (max_participants IS NULL OR max_participants BETWEEN 1 AND 100) AND (min_participants IS NULL OR max_participants IS NULL OR min_participants <= max_participants)")
export class CoachingProgramEntity {
  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "coaching_programs_pkey" })
  id!: string;

  @Column({ name: "name", type: "text" })
  name!: string;

  @Column({ name: "description", type: "text" })
  description!: string;

  @Column({ name: "program_type", type: "text" })
  programType!: CoachingProgramType;

  @Column({ name: "min_participants", type: "integer", nullable: true })
  minParticipants!: number | null;

  @Column({ name: "max_participants", type: "integer", nullable: true })
  maxParticipants!: number | null;

  @Column({ name: "court_rental_included", type: "boolean" })
  courtRentalIncluded!: boolean;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
