import "server-only";

import { notFound, redirect } from "next/navigation";
import { readCurrentAccount } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";

export async function requireReservationRole(client: Awaited<ReturnType<typeof createClient>>) {
  const account = await readCurrentAccount(client);
  if (account.state === "unauthenticated" || account.state === "missing-profile") redirect("/login");
  if (account.state !== "active" || !account.roles.some((role) => role === "admin" || role === "coach")) notFound();
  return account;
}

export async function requireAdminReservationRole(client: Awaited<ReturnType<typeof createClient>>) {
  const account = await requireReservationRole(client);
  if (!account.roles.includes("admin")) notFound();
  return account;
}
