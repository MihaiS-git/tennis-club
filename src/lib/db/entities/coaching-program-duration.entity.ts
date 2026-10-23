import "server-only";

import { Check, Entity, ForeignKey, PrimaryColumn } from "typeorm";

import { CoachingProgramEntity } from "./coaching-program.entity";

// The lesson lengths a program offers; prices reference one of them.
@Entity({ schema: "public", name: "coaching_program_durations" })
@ForeignKey(() => CoachingProgramEntity, ["programId"], ["id"], { name: "coaching_program_durations_program_id_fkey", onDelete: "CASCADE" })
@Check("coaching_program_durations_minutes_check", "duration_minutes IN (60, 90, 120)")
export class CoachingProgramDurationEntity {
  @PrimaryColumn({ name: "program_id", type: "uuid", primaryKeyConstraintName: "coaching_program_durations_pkey" })
  programId!: string;

  @PrimaryColumn({ name: "duration_minutes", type: "integer", primaryKeyConstraintName: "coaching_program_durations_pkey" })
  durationMinutes!: number;
}
