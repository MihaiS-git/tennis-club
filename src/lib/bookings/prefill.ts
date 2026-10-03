import "server-only";

import { readCurrentAccount } from "@/lib/auth/account";
import { loadProfile } from "@/lib/profile/profile";
import { createClient } from "@/lib/supabase/server";
import type { BookingContact } from "./domain";

export async function bookingContactPrefill(client?: Awaited<ReturnType<typeof createClient>>): Promise<BookingContact> {
  const reader = client ?? await createClient();
  const account = await readCurrentAccount(reader);
  if (account.state !== "active") return { customerName: "", customerEmail: "", customerPhone: "" };
  const profile = await loadProfile(reader, account.userId);
  const name = [profile?.personal.first_name, profile?.personal.last_name].filter(Boolean).join(" ").trim();
  return { customerName: name || profile?.player?.display_name?.trim() || "",
    customerEmail: account.email, customerPhone: profile?.personal.phone ?? "" };
}
