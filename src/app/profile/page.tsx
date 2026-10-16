import type { Metadata } from "next";
import { UserRound } from "lucide-react";
import { effectiveDisplayName, playerAvatarUrl } from "@/lib/profile/presentation";
import { readOwnProfile } from "./own-profile";
import { AvatarForms } from "./profile-forms";

export const metadata: Metadata = { title: "Player identity | Tennis Club" };

export default async function ProfilePage() {
  const result = await readOwnProfile();
  if ("unavailable" in result) return result.unavailable;
  const { profile } = result;
  const imageUrl = playerAvatarUrl(profile.player);
  const playerName = effectiveDisplayName(profile.player?.display_name, profile.personal) || "Your profile";
  return (
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
  );
}
