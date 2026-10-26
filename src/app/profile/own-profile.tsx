import { redirect } from "next/navigation";
import { signOutAction } from "@/app/account/actions";
import { SubmitButton } from "@/components/submit-button";
import { loadProfile, profileContext } from "@/lib/profile/profile";

// Every Profile route reads only the current active account's own profile.
export async function readOwnProfile() {
  const { account } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  const profile = account.state === "active" ? await loadProfile(account.userId) : null;
  if (!profile || account.state !== "active") {
    const description = account.state === "suspended" ? "This account is restricted. Contact club support."
      : account.state === "missing-profile" ? "Your account is missing its required application record. Contact club support."
      : "We couldn't load your profile. Please try again.";
    return { unavailable: <section className="max-w-3xl rounded-card border border-border bg-surface-elevated p-5 shadow-card md:p-6">
      <h2 className="font-heading text-xl font-semibold text-primary">{account.state === "suspended" ? "Account suspended" : "Profile unavailable"}</h2>
      <p className="mt-2 mb-5 text-sm leading-6 text-muted-foreground">{description}</p>
      <form action={signOutAction} className="[&>button]:min-h-11"><SubmitButton variant="secondary" pendingLabel="Signing out…">Sign out</SubmitButton></form>
    </section> } as const;
  }
  return { account, profile } as const;
}
