import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { coveragePeriodsOverlap, coverageMutationSchema, coverageRemovalSchema, coveragePeriodSchema, type CoverageMutationResult } from "@/lib/courts/coverage-validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";

class CoverageParentChanged extends Error {}

type Client = Awaited<ReturnType<typeof createClient>>;

export async function listAdminCourtCoverage(supabase?: Client) {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  try {
    const rows = await clubs.listCourtCoverage((await getDataSource()).manager);
    return z.array(coveragePeriodSchema).parse(rows.map((row) => ({
      id: row.id, court_id: row.courtId, starts_on: row.startsOn, ends_on: row.endsOn,
      created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
    })));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    logger.error({ event: "admin.court_coverage_list_failed", kind: failure.kind, code: failure.sqlState }, "Failed to load court coverage");
    throw new Error("Unable to load coverage periods.");
  }
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
  let failureMessage = "Unable to change coverage period.";
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await inTransaction<CoverageMutationResult>(async (manager) => {
          await clubs.lockConfigurationForWrite(manager);
          failureMessage = "Unable to load court.";
          const court = await clubs.findCourtConfiguration(manager, court_id);
          if (!court) return { ok: false, reason: "not-found" };
          failureMessage = "Unable to change coverage period.";
          await clubs.lockLocations(manager, [court.locationId]);
          const authoritative = await clubs.findCourtConfiguration(manager, court_id);
          if (!authoritative) return { ok: false, reason: "not-found" };
          if (authoritative.locationId !== court.locationId) throw new CoverageParentChanged();
          if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
          if (authoritative.environment !== "outdoor") return { ok: false, reason: "outdoor-only" };
          let savedId: string | null;
          if (remove && id) {
            savedId = await clubs.deleteCourtCoverage(manager, id, court_id);
          } else if ("dates" in parsed.data) {
            const proposedDates = parsed.data.dates;
            const current = await clubs.listCourtCoverage(manager, court_id);
            if (id && !current.some((row) => row.id === id.toLowerCase())) return { ok: false, reason: "not-found" };
            if (current.some((row) => row.id !== id?.toLowerCase() && coveragePeriodsOverlap(proposedDates,
              { starts_on: row.startsOn, ends_on: row.endsOn }))) return { ok: false, reason: "overlap" };
            const dates = { startsOn: parsed.data.dates.starts_on, endsOn: parsed.data.dates.ends_on };
            savedId = id
              ? await clubs.updateCourtCoverage(manager, id, court_id, dates, new Date())
              : await clubs.insertCourtCoverage(manager, court_id, dates, new Date());
          } else {
            return { ok: false, reason: "not-found" };
          }
          return savedId ? { ok: true, id: savedId } : { ok: false, reason: "not-found" };
        });
      } catch (error) {
        if (!(error instanceof CoverageParentChanged) || attempt === 2) throw error;
      }
    }
    throw new Error("Court parent changed repeatedly.");
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01") return { ok: false, reason: "overlap" };
    if (failure.sqlState === "23503") return { ok: false, reason: "outdoor-only" };
    logger.error({ event: failureMessage === "Unable to load court." ? "admin.court_coverage_court_failed" : "admin.court_coverage_mutation_failed",
      actorId: actor.userId, courtId: court_id, kind: failure.kind, code: failure.sqlState }, "Failed to change court coverage");
    throw new Error(failureMessage);
  }
}

export async function saveAdminCourtCoverage(input: unknown, supabase?: Client) {
  return mutateCoverage(input, false, supabase);
}
export async function removeAdminCourtCoverage(input: unknown, supabase?: Client) {
  return mutateCoverage(input, true, supabase);
}
