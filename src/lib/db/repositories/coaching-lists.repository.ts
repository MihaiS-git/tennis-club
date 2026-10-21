import "server-only";

import { In, type EntityManager } from "typeorm";
import { z } from "zod";
import type { CoachFilters, PriceFilters, ProgramFilters } from "@/lib/coaching/admin-filters";
import { CoachingProgramEntity } from "../entities/coaching-program.entity";
import { CoachingProgramDurationEntity } from "../entities/coaching-program-duration.entity";
import { CoachingPriceEntity } from "../entities/coaching-price.entity";

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

const priceGroupSchema = z.object({ program_id: z.uuid(), location_id: z.uuid(), duration_minutes: z.number().int() });

// A group is one program × duration × location, retaining the existing editor for
// unset prices. Targets include the club and assigned coaches. Filter targets
// before grouping, so several matching coach prices never duplicate a group.
export async function listPriceGroupsPage(manager: EntityManager, filters: PriceFilters) {
  const parameters: (string | number)[] = [];
  const where: string[] = [];
  function parameter(value: string | number) { parameters.push(value); return `$${parameters.length}`; }
  if (filters.location) where.push(`location_id=${parameter(filters.location)}::uuid`);
  if (filters.program) where.push(`program_id=${parameter(filters.program)}::uuid`);
  if (filters.duration) where.push(`duration_minutes=${parameter(filters.duration)}`);
  if (filters.scope === "club") where.push("coach_user_id IS NULL AND amount_minor IS NOT NULL");
  if (filters.scope === "coach") where.push("coach_user_id IS NOT NULL AND amount_minor IS NOT NULL");
  if (filters.coach) where.push(`coach_user_id=${parameter(filters.coach)}::uuid`);
  if (filters.search) {
    const search = parameter(filters.search);
    where.push(`(strpos(lower(program_name),lower(${search}))>0 OR strpos(lower(coalesce(coach_name,'')),lower(${search}))>0 OR strpos(lower(coalesce(email,'')),lower(${search}))>0)`);
  }
  const cte = `WITH targets AS (
    SELECT p.id AS program_id,p.name AS program_name,l.id AS location_id,l.name AS location_name,d.duration_minutes,
      c.user_id AS coach_user_id,c.display_name AS coach_name,u.email,x.amount_minor
    FROM public.coaching_programs p
    JOIN public.coaching_program_durations d ON d.program_id=p.id
    CROSS JOIN public.locations l
    CROSS JOIN LATERAL (
      SELECT NULL::uuid AS user_id,NULL::text AS display_name
      UNION ALL SELECT cp.user_id,cp.display_name FROM public.coach_profiles cp
      JOIN public.coach_programs ap ON ap.coach_user_id=cp.user_id AND ap.program_id=p.id
      JOIN public.coach_locations al ON al.coach_user_id=cp.user_id AND al.location_id=l.id
      WHERE cp.archived_at IS NULL
    ) c
    LEFT JOIN public.users u ON u.id=c.user_id
    LEFT JOIN public.coaching_prices x ON x.program_id=p.id AND x.duration_minutes=d.duration_minutes
      AND x.location_id=l.id AND x.coach_user_id IS NOT DISTINCT FROM c.user_id
    WHERE l.archived_at IS NULL
  ), groups AS (
    SELECT program_id,location_id,duration_minutes,program_name,location_name,min(amount_minor) AS amount
    FROM targets ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY program_id,location_id,duration_minutes,program_name,location_name
  )`;
  const counts: unknown = await manager.query(`${cte} SELECT count(*)::int AS total FROM groups`, parameters);
  const paging = pagination(z.array(z.object({ total: z.number().int() })).parse(counts)[0].total, filters.page);
  const column = { program: "program_name", location: "location_name", duration: "duration_minutes", amount: "amount" }[filters.sort];
  const rows: unknown = await manager.query(`${cte} SELECT program_id,location_id,duration_minutes FROM groups
    ORDER BY ${column} ${filters.dir === "asc" ? "ASC" : "DESC"} NULLS LAST,program_id,location_id,duration_minutes
    LIMIT ${pageSize} OFFSET ${(paging.page - 1) * pageSize}`, parameters);
  const groups = z.array(priceGroupSchema).parse(rows);
  const prices = groups.length ? await manager.getRepository(CoachingPriceEntity).find({ where: groups.map(group => ({
    programId: group.program_id, locationId: group.location_id, durationMinutes: group.duration_minutes,
  })) }) : [];
  return { ...paging, groups, prices };
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
