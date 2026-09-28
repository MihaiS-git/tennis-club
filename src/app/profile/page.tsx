import { UserRound } from "lucide-react";
import { redirect } from "next/navigation";
import { signOutAction } from "@/app/account/actions";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { SubmitButton } from "@/components/submit-button";
import { loadProfile, profileContext } from "@/lib/profile/profile";
import { effectiveDisplayName, playerAvatarUrl } from "@/lib/profile/presentation";
import { AvatarForms, PersonalInformationForm, TennisProfileForm } from "./profile-forms";
import { ProfileSettings } from "./profile-settings";

export default async function ProfilePage() {
  const { client, account } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  const profile = account.state === "active" ? await loadProfile(client, account.userId) : null;
  if (!profile || account.state !== "active") {
    const description = account.state === "suspended" ? "This account is restricted. Contact club support."
      : account.state === "missing-profile" ? "Your account is missing its required application record. Contact club support."
      : "We couldn't load your profile. Please try again.";
    return <main className="flex-1 bg-background px-6 py-12"><section className="mx-auto max-w-3xl rounded-card border border-border bg-surface p-6">
      <h1 className="font-heading text-3xl font-semibold">{account.state === "suspended" ? "Account suspended" : "Profile unavailable"}</h1>
      <p className="my-5 text-muted-foreground">{description}</p>
      <form action={signOutAction} className="[&>button]:min-h-11"><SubmitButton variant="secondary" pendingLabel="Signing out…">Sign out</SubmitButton></form>
    </section></main>;
  }
  const imageUrl = playerAvatarUrl(profile.player);
  const playerName = effectiveDisplayName(profile.player?.display_name, profile.personal) || "Your profile";
  return (
    <main className="flex-1 bg-background">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:space-y-8 lg:px-8 lg:py-12">
        <header>
          <p className="text-sm font-medium text-accent">Your club profile</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Profile</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Manage your player identity, personal details and account settings.</p>
        </header>
        <ProfileSettings
          identity={
            <section aria-labelledby="player-identity-heading" className="rounded-card border border-border bg-surface-elevated p-5 shadow-card sm:p-6 lg:p-8">
              <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_18rem] md:items-center md:gap-8">
                <div className="flex min-w-0 items-center gap-4 sm:gap-6">
                  {imageUrl ?
                    // eslint-disable-next-line @next/next/no-img-element -- The authenticated avatar endpoint serves normalized images directly.
                    <img src={imageUrl} alt="Your player avatar" width={112} height={112} loading="eager" className="size-20 shrink-0 rounded-full object-cover sm:size-28" />
                    : <div role="img" aria-label="Default player avatar" className="flex size-20 shrink-0 items-center justify-center rounded-full bg-surface-muted text-primary sm:size-28"><UserRound className="size-9 sm:size-12" aria-hidden="true" /></div>}
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">Player profile</p>
                    <h2 id="player-identity-heading" className="mt-1 break-words font-heading text-2xl font-semibold text-primary sm:text-3xl">{playerName}</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{profile.player ? "Your player identity at Tennis Club." : "Add your tennis details to complete your player profile."}</p>
                    {(profile.player?.rating !== null && profile.player?.rating !== undefined || profile.player?.sportya_level) && (
                      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-3 text-sm">
                        {profile.player?.rating !== null && profile.player?.rating !== undefined && <div><dt className="text-xs text-muted-foreground">Club rating</dt><dd className="mt-1 font-semibold text-primary">{profile.player.rating}</dd></div>}
                        {profile.player?.sportya_level && <div className="min-w-0"><dt className="text-xs text-muted-foreground">Sportya level</dt><dd className="mt-1 break-words font-semibold text-primary">{profile.player.sportya_level}</dd></div>}
                      </dl>
                    )}
                  </div>
                </div>
                <div className="min-w-0 border-t border-border pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0">
                  <AvatarForms hasAvatar={Boolean(profile.player?.avatar_path)} hasProfile={Boolean(profile.player)} />
                </div>
              </div>
            </section>
          }
          personal={<PersonalInformationForm profile={profile.personal} />}
          tennis={<TennisProfileForm profile={profile.player} personal={profile.personal} />}
          account={
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
          }
        />
      </div>
    </main>
  );
}
