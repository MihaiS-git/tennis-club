import { readCurrentAccount } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";
import { MobileNavbarMenu } from "./mobile-navbar-menu";

export async function MobileNavbar() {
  const supabase = await createClient();
  const account = await readCurrentAccount(supabase);

  return <MobileNavbarMenu isAuthenticated={account.state !== "unauthenticated"} />;
}
