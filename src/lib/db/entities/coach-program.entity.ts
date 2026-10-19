import "server-only";

import { Entity, ForeignKey, PrimaryColumn } from "typeorm";

import { CoachProfileEntity } from "./coach-profile.entity";
import { CoachingProgramEntity } from "./coaching-program.entity";

@Entity({ schema: "public", name: "coach_programs" })
@ForeignKey(() => CoachProfileEntity, ["coachUserId"], ["userId"], { name: "coach_programs_coach_user_id_fkey", onDelete: "CASCADE" })
@ForeignKey(() => CoachingProgramEntity, ["programId"], ["id"], { name: "coach_programs_program_id_fkey", onDelete: "RESTRICT" })
export class CoachProgramEntity {
  @PrimaryColumn({ name: "coach_user_id", type: "uuid", primaryKeyConstraintName: "coach_programs_pkey" })
  coachUserId!: string;

  @PrimaryColumn({ name: "program_id", type: "uuid", primaryKeyConstraintName: "coach_programs_pkey" })
  programId!: string;
}
