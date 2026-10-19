import "server-only";

import { notFound, redirect } from "next/navigation";

import { readCurrentAccount } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";

// The Coach area requires an active account currently holding the coach role.
// Other roles (including admin) may also be held.
export async function requireActiveCoach(
  supabase?: Parameters<typeof readCurrentAccount>[0],
) {
  const account = await readCurrentAccount(supabase ?? await createClient());

  if (account.state === "unauthenticated" || account.state === "missing-profile") {
    redirect("/login");
  }

  if (account.state !== "active" || !account.roles.includes("coach")) {
    notFound();
  }

  return account;
}
