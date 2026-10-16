import type { Metadata } from "next";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { readOwnProfile } from "../own-profile";
import { ProfileSection } from "../profile-section";

export const metadata: Metadata = { title: "Account & security | Tennis Club" };

export default async function AccountSecurityPage() {
  const result = await readOwnProfile();
  if ("unavailable" in result) return result.unavailable;
  const { account } = result;
  return <ProfileSection id="account" title="Account & security" description="Your sign-in details, password and account access.">
    <div className="space-y-6">
      <dl className="grid min-w-0 gap-5 rounded-control border border-border bg-background p-4 lg:grid-cols-2">
        <div className="min-w-0"><dt className="text-xs font-medium text-muted-foreground">Email address</dt><dd className="mt-2 break-words text-sm font-medium">{account.email}</dd></div>
        <div><dt className="text-xs font-medium text-muted-foreground">Roles</dt><dd className="mt-2">
          {account.roles.length === 0 && <p className="text-sm text-muted-foreground">No assigned roles</p>}
          <ul className="flex flex-wrap gap-2" aria-label="Assigned roles">
            {account.roles.map((role) => <li key={role} className="rounded-control bg-surface-muted px-2.5 py-1 text-xs font-medium capitalize text-primary">{role}</li>)}
          </ul>
        </dd></div>
      </dl>
      <section aria-labelledby="change-password-heading" className="max-w-md">
        <h3 id="change-password-heading" className="font-heading text-lg font-semibold">Change password</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Enter your current password to choose a new one.</p>
        <ChangePasswordForm />
      </section>
    </div>
  </ProfileSection>;
}
