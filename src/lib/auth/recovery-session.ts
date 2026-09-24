import type { createClient } from "@/lib/supabase/server";

export async function hasRecoverySession(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<boolean> {
  const { data: identity, error: identityError } = await supabase.auth.getUser();
  if (identityError || !identity.user) return false;

  const { data, error } = await supabase.auth.getClaims();
  if (error || !data || data.claims.sub !== identity.user.id) return false;

  return data.claims.amr?.some((entry) =>
    typeof entry === "string" ? entry === "recovery" : entry.method === "recovery",
  ) ?? false;
}
