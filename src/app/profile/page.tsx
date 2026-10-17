import type { Metadata } from "next";
import { UserRound } from "lucide-react";
import { effectiveDisplayName, playerAvatarUrl, tennisChoiceLabel, tennisChoiceLabels, tennisChoiceNames } from "@/lib/profile/presentation";
import { readOwnProfile } from "./own-profile";
import { AvatarForms } from "./profile-forms";

export const metadata: Metadata = { title: "Player identity | Tennis Club" };

export default async function ProfilePage() {
  const result = await readOwnProfile();
  if ("unavailable" in result) return result.unavailable;
  const { profile } = result;
  const imageUrl = playerAvatarUrl(profile.player);
  const playerName = effectiveDisplayName(profile.player?.display_name, profile.personal) || "Your profile";
  const player = profile.player;
  const highlights = [
    ["Club rating", player?.rating !== null && player?.rating !== undefined ? String(player.rating) : null],
    ["Sportya level", player?.sportya_level ? `Level ${player.sportya_level}` : null],
  ].filter((item): item is [string, string] => item[1] !== null);
  return (
    <section aria-labelledby="player-identity-heading" className="min-w-0 rounded-card border border-border bg-surface-elevated shadow-card">
      <div className="flex min-w-0 flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-7 md:p-6">
        <div className="flex max-w-full shrink-0 flex-col items-start gap-2 sm:w-36 sm:items-center">
          {imageUrl ?
            // eslint-disable-next-line @next/next/no-img-element -- The authenticated avatar endpoint serves normalized images directly.
            <img src={imageUrl} alt="Your player avatar" width={144} height={144} loading="eager" className="size-28 shrink-0 rounded-full border-4 border-surface object-cover ring-1 ring-border sm:size-36" />
            : <div role="img" aria-label="Default player avatar" className="flex size-28 shrink-0 items-center justify-center rounded-full border-4 border-surface bg-surface-muted text-primary ring-1 ring-border sm:size-36"><UserRound className="size-12 sm:size-16" aria-hidden="true" /></div>}
          <AvatarForms hasAvatar={Boolean(player?.avatar_path)} hasProfile={Boolean(player)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Player profile</p>
          <h2 id="player-identity-heading" className="mt-1 break-words font-heading text-2xl font-semibold leading-tight text-primary sm:text-3xl">{playerName}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{player ? "Your player identity at Tennis Club." : "Add your tennis details to complete your player profile."}</p>
          {highlights.length > 0 && <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
            {highlights.map(([label, value]) => <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 break-words font-heading text-lg font-semibold leading-tight text-primary">{value}</dd>
            </div>)}
          </dl>}
        </div>
      </div>
      {player && <div className="space-y-6 border-t border-border p-5 md:p-6">
        <section aria-labelledby="playing-style-heading">
          <h3 id="playing-style-heading" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Playing style</h3>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 min-[360px]:grid-cols-2 xl:grid-cols-4">
            {tennisChoiceNames.map((name) => {
              const value = tennisChoiceLabel(name, player[name]);
              return <div key={name} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{tennisChoiceLabels[name]}</dt>
                <dd className={`mt-1 break-words text-sm leading-6 ${value ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{value ?? "Not specified"}</dd>
              </div>;
            })}
          </dl>
        </section>
        <section aria-labelledby="about-me-heading">
          <h3 id="about-me-heading" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">About me</h3>
          <p className={`mt-3 max-w-prose whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere] ${player.bio?.trim() ? "text-foreground" : "text-muted-foreground"}`}>{player.bio?.trim() ? player.bio : "You haven’t added a biography yet."}</p>
        </section>
      </div>}
    </section>
  );
}
