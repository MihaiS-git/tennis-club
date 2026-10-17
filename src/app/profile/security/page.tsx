import type { Metadata } from "next";
import { BadgeCheck, KeyRound, Mail, ShieldCheck } from "lucide-react";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { readOwnProfile } from "../own-profile";
import { ProfileSection } from "../profile-section";

export const metadata: Metadata = { title: "Account & security | Tennis Club" };

export default async function AccountSecurityPage() {
  const result = await readOwnProfile();
  if ("unavailable" in result) return result.unavailable;
  const { account } = result;
  return <ProfileSection id="account" icon={ShieldCheck} title="Account & security" description="Your sign-in details, password and account access.">
    {/* Sign-in details and password change sit side by side on wide screens, stacked below. */}
    <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-0">
      <section aria-labelledby="sign-in-heading" className="min-w-0 lg:pr-8">
        <h3 id="sign-in-heading" className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Sign-in details</h3>
        <dl className="grid min-w-0 divide-y divide-border rounded-control border border-border bg-background">
          <div className="min-w-0 px-4 py-3">
            <dt className="flex items-center gap-2 text-sm text-muted-foreground"><Mail aria-hidden="true" className="size-4" />Email address</dt>
            <dd className="mt-1 min-w-0 break-words text-sm font-semibold text-foreground">{account.email}</dd>
          </div>
          {/* Ordinary players have no explicit roles; only assigned roles are shown. */}
          {account.roles.length > 0 && <div className="min-w-0 px-4 py-3">
            <dt className="flex items-center gap-2 text-sm text-muted-foreground"><BadgeCheck aria-hidden="true" className="size-4" />Roles</dt>
            <dd className="mt-2 min-w-0">
              <ul className="flex flex-wrap gap-2" aria-label="Assigned roles">
                {account.roles.map((role) => <li key={role} className="rounded-full bg-success-background px-2.5 py-0.5 text-xs font-semibold capitalize text-primary">{role}</li>)}
              </ul>
            </dd>
          </div>}
        </dl>
      </section>
      <section aria-labelledby="change-password-heading" className="min-w-0 border-t border-border pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
        <h3 id="change-password-heading" className="flex items-center gap-2 font-heading text-lg font-semibold text-primary"><KeyRound aria-hidden="true" className="size-4 text-accent" />Change password</h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Enter your current password to choose a new one.</p>
        <div className="max-w-md"><ChangePasswordForm /></div>
      </section>
    </div>
  </ProfileSection>;
}
