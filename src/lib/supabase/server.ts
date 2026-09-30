import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

// Share the user-scoped client only within one server render/request.
export const createClient = cache(async function createClient(fetchOverride?: typeof fetch) {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      ...(fetchOverride ? { global: { fetch: fetchOverride } } : {}),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot write cookies.
            // Session refresh is handled by proxy.ts.
          }
        },
      },
    },
  );
});
