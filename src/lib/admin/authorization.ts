import "server-only";

import { notFound, redirect } from "next/navigation";

import { readCurrentAccount } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";

export async function requireActiveAdmin(
  supabase?: Parameters<typeof readCurrentAccount>[0],
) {
  const account = await readCurrentAccount(supabase ?? await createClient());

  if (account.state === "unauthenticated" || account.state === "missing-profile") {
    redirect("/login");
  }

  if (account.state !== "active" || !account.roles.includes("admin")) {
    notFound();
  }

  return account;
}
