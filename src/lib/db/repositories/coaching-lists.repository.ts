import "server-only";

import { In, type EntityManager } from "typeorm";
import { z } from "zod";
import type { CoachFilters, ProgramFilters } from "@/lib/coaching/admin-filters";
import { CoachingProgramEntity } from "../entities/coaching-program.entity";
import { CoachingProgramDurationEntity } from "../entities/coaching-program-duration.entity";

const pageSize = 20;
function pagination(total: number, requested: number) {
  const totalPages = Math.ceil(total / pageSize);
  const page = Math.min(requested, Math.max(1, totalPages));
  return { total, totalPages, page, pageSize };
}

export async function listProgramsPage(manager: EntityManager, filters: ProgramFilters) {
  const query = manager.getRepository(CoachingProgramEntity).createQueryBuilder("program");
  if (filters.search) query.andWhere("strpos(lower(program.name), lower(:search)) > 0", { search: filters.search });
  if (filters.type) query.andWhere("program.program_type = :type", { type: filters.type });
  if (filters.status) query.andWhere("program.is_active = :active", { active: filters.status === "active" });
  const paging = pagination(await query.getCount(), filters.page);
  const column = { name: "program.name", type: "program.program_type", status: "CASE WHEN program.is_active THEN 0 ELSE 1 END" }[filters.sort];
  const programs = await query.orderBy(column, filters.dir === "asc" ? "ASC" : "DESC").addOrderBy("program.id", "ASC")
    .offset((paging.page - 1) * pageSize).limit(pageSize).getMany();
  const durations = programs.length ? await manager.getRepository(CoachingProgramDurationEntity).find({
    where: { programId: In(programs.map(program => program.id)) }, order: { durationMinutes: "ASC" },
  }) : [];
  return { ...paging, programs: programs.map(program => ({ ...program,
    durations: durations.filter(duration => duration.programId === program.id).map(duration => duration.durationMinutes) })) };
}

const coachManagementRowSchema = z.object({
  user_id: z.uuid(), name: z.string(), email: z.string(), account_status: z.enum(["active", "suspended"]),
  profile_status: z.enum(["configured", "not-configured", "archived"]),
  display_name: z.string().nullable(), bio: z.string().nullable(), qualifications: z.string().nullable(),
  specialties: z.array(z.string()).nullable(), languages: z.array(z.string()).nullable(), is_public: z.boolean().nullable(),
  location_ids: z.array(z.uuid()), program_ids: z.array(z.uuid()),
});

// One row per Coach-role account. Assignments are aggregated only for the page;
// neither their cardinality nor public booking eligibility changes the population.
export async function listCoachesPage(manager: EntityManager, filters: CoachFilters) {
  const parameters: string[] = [];
  const where: string[] = ["EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id=u.id AND r.role_code='coach')"];
  function parameter(value: string) { parameters.push(value); return `$${parameters.length}`; }
  const profileStatus = "CASE WHEN c.user_id IS NULL THEN 'not-configured' WHEN c.archived_at IS NOT NULL THEN 'archived' ELSE 'configured' END";
  const name = "coalesce(nullif(c.display_name,''),nullif(btrim(concat_ws(' ',u.first_name,u.last_name)),''),u.email)";
  if (filters.search) {
    const search = parameter(filters.search);
    where.push(`(strpos(lower(coalesce(u.first_name,'')),lower(${search}))>0 OR strpos(lower(coalesce(u.last_name,'')),lower(${search}))>0 OR strpos(lower(u.email),lower(${search}))>0 OR strpos(lower(coalesce(c.display_name,'')),lower(${search}))>0)`);
  }
  if (filters.status) where.push(`u.status=${parameter(filters.status)}`);
  if (filters.profile) where.push(`(${profileStatus})=${parameter(filters.profile)}`);
  // Public means a configured, unarchived public profile; every other Coach account is hidden.
  const isPublic = "(c.user_id IS NOT NULL AND c.archived_at IS NULL AND c.is_public)";
  if (filters.visibility) where.push(filters.visibility === "public" ? isPublic : `NOT ${isPublic}`);
  const from = `FROM public.users u LEFT JOIN public.coach_profiles c ON c.user_id=u.id WHERE ${where.join(" AND ")}`;
  const counts: unknown = await manager.query(`SELECT count(*)::int AS total ${from}`, parameters);
  const paging = pagination(z.array(z.object({ total: z.number().int() })).parse(counts)[0].total, filters.page);
  const column = { name: `lower(${name})`, email: "lower(u.email)", status: "u.status", profile: profileStatus, created: "u.created_at" }[filters.sort];
  const rows: unknown = await manager.query(`SELECT u.id AS user_id,${name} AS name,u.email,u.status AS account_status,
    ${profileStatus} AS profile_status,c.display_name,c.bio,c.qualifications,c.specialties,c.languages,c.is_public,
    coalesce((SELECT array_agg(l.location_id ORDER BY l.location_id) FROM public.coach_locations l WHERE l.coach_user_id=u.id),'{}') AS location_ids,
    coalesce((SELECT array_agg(p.program_id ORDER BY p.program_id) FROM public.coach_programs p WHERE p.coach_user_id=u.id),'{}') AS program_ids
    ${from} ORDER BY ${column} ${filters.dir === "asc" ? "ASC" : "DESC"},u.id ASC
    LIMIT ${pageSize} OFFSET ${(paging.page - 1) * pageSize}`, parameters);
  return { ...paging, coaches: z.array(coachManagementRowSchema).parse(rows) };
}
