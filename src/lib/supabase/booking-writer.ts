import "server-only";

import { createClient } from "@supabase/supabase-js";

// Only the customer booking service uses this privileged client. It has no browser export.
export function createBookingWriter() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Customer booking persistence is not configured.");
  return createClient(process.env.SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
