import "server-only";

import { z } from "zod";

import { decideAccountAccess } from "@/lib/auth/decisions";
import { createClient } from "@/lib/supabase/server";

const roleSchema = z.enum(["admin", "coach", "member"]);

export type UserRole = z.infer<typeof roleSchema>;

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type CurrentAccount =
  | { state: "unauthenticated" }
  | { state: "missing-profile" }
  | { state: "load-error" }
  | { state: "suspended"; userId: string; email: string; roles: UserRole[] }
  | { state: "active"; userId: string; email: string; roles: UserRole[] };

export async function readCurrentAccount(
  supabase: SupabaseClient,
): Promise<CurrentAccount> {
  const { data: identity, error: identityError } = await supabase.auth.getUser();

  if (identityError || !identity.user) return { state: "unauthenticated" };

  const [profileResult, rolesResult] = await Promise.all([
    supabase
      .from("users")
      .select("email, status")
      .eq("id", identity.user.id)
      .maybeSingle(),
    supabase
      .from("user_roles")
      .select("role_code")
      .eq("user_id", identity.user.id)
      .order("role_code"),
  ]);

  if (profileResult.error || rolesResult.error) {
    console.error("Failed to load the authenticated application account", {
      profileCode: profileResult.error?.code,
      rolesCode: rolesResult.error?.code,
    });
    return { state: "load-error" };
  }

  if (!profileResult.data) return { state: "missing-profile" };

  const access = decideAccountAccess(profileResult.data.status);
  const parsedRoles = roleSchema.array().safeParse(
    rolesResult.data?.map((assignment) => assignment.role_code),
  );

  if (
    access === "structural-error" ||
    !profileResult.data.email ||
    !parsedRoles.success ||
    parsedRoles.data.length === 0
  ) {
    return { state: "load-error" };
  }

  return {
    state: access,
    userId: identity.user.id,
    email: profileResult.data.email,
    roles: parsedRoles.data,
  };
}
