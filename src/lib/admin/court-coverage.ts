import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { coverageMutationSchema, coverageRemovalSchema, coveragePeriodSchema, type CoverageMutationResult } from "@/lib/courts/coverage-validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type Client = Awaited<ReturnType<typeof createClient>>;

export async function listAdminCourtCoverage(supabase?: Client) {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  const { data, error } = await client.from("court_coverage_periods")
    .select("id, court_id, starts_on, ends_on, created_at, updated_at").order("starts_on").order("id");
  const parsed = z.array(coveragePeriodSchema).safeParse(data);
  if (error || !parsed.success) {
    logger.error({ event: "admin.court_coverage_list_failed", code: error?.code }, "Failed to load court coverage");
    throw new Error("Unable to load coverage periods.");
  }
  return parsed.data;
}

async function mutateCoverage(input: unknown, remove: boolean, supabase?: Client): Promise<CoverageMutationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = (remove ? coverageRemovalSchema : coverageMutationSchema).safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
    return { ok: false, reason: "invalid-input", fieldErrors };
  }
  const { court_id, id } = parsed.data;
  // Re-read authoritative environment; the database FK also guards races.
  const court = await client.from("courts").select("environment").eq("id", court_id).maybeSingle();
  if (court.error) {
    logger.error({ event: "admin.court_coverage_court_failed", code: court.error.code }, "Failed to load court");
    throw new Error("Unable to load court.");
  }
  if (!court.data) return { ok: false, reason: "not-found" };
  if (court.data.environment !== "outdoor") return { ok: false, reason: "outdoor-only" };
  let query;
  if (remove && id) {
    query = client.from("court_coverage_periods").delete().eq("id", id).eq("court_id", court_id);
  } else if ("dates" in parsed.data) {
    const values = { ...parsed.data.dates, updated_at: new Date().toISOString() };
    query = id
      ? client.from("court_coverage_periods").update(values).eq("id", id).eq("court_id", court_id)
      : client.from("court_coverage_periods").insert({ court_id, ...values });
  } else {
    return { ok: false, reason: "not-found" };
  }
  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    if (error.code === "23P01") return { ok: false, reason: "overlap" };
    if (error.code === "23503") return { ok: false, reason: "outdoor-only" };
    logger.error({ event: "admin.court_coverage_mutation_failed", actorId: actor.userId, courtId: court_id, code: error.code }, "Failed to change court coverage");
    throw new Error("Unable to change coverage period.");
  }
  if (!data) return { ok: false, reason: "not-found" };
  return { ok: true, id: z.uuid().parse(data.id) };
}

export async function saveAdminCourtCoverage(input: unknown, supabase?: Client) {
  return mutateCoverage(input, false, supabase);
}
export async function removeAdminCourtCoverage(input: unknown, supabase?: Client) {
  return mutateCoverage(input, true, supabase);
}
