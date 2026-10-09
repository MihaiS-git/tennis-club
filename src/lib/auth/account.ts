import "server-only";

import { z } from "zod";
import { cache } from "react";

import { decideAccountAccess } from "@/lib/auth/decisions";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { findAccountById } from "@/lib/db/repositories/accounts.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const roleSchema = z.enum(["admin", "coach"]);

export type UserRole = z.infer<typeof roleSchema>;

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type CurrentAccount =
  | { state: "unauthenticated" }
  | { state: "missing-profile" }
  | { state: "load-error" }
  | { state: "suspended"; userId: string; email: string; roles: UserRole[] }
  | { state: "active"; userId: string; email: string; roles: UserRole[] };

// Deduplicate identity, profile, and role reads for callers sharing a request client.
export const readCurrentAccount = cache(async function readCurrentAccount(
  supabase: SupabaseClient,
): Promise<CurrentAccount> {
  const { data: identity, error: identityError } = await supabase.auth.getUser();

  if (identityError || !identity.user) return { state: "unauthenticated" };

  let persistence;
  try {
    const dataSource = await getDataSource();
    persistence = await findAccountById(dataSource.manager, identity.user.id);
  } catch (error: unknown) {
    const databaseError = normalizeDatabaseError(error);
    logger.error({
      event: "auth.account_load_failed",
      kind: databaseError.kind,
      sqlState: databaseError.sqlState,
    }, "Failed to load the authenticated application account");
    return { state: "load-error" };
  }

  if (!persistence) return { state: "missing-profile" };

  const access = decideAccountAccess(persistence.user.status);
  const parsedRoles = roleSchema.array().safeParse(persistence.roleCodes);

  if (
    access === "structural-error" ||
    !persistence.user.email ||
    !parsedRoles.success
  ) {
    return { state: "load-error" };
  }

  return {
    state: access,
    userId: identity.user.id,
    email: persistence.user.email,
    roles: parsedRoles.data,
  };
});
