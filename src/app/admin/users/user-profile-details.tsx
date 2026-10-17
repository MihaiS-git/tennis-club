"use client";

import { Fragment, useState, type ReactNode } from "react";
import { UserRound } from "lucide-react";
import type { AdminUserDetails } from "@/lib/admin/users";
import { formatUserDate } from "./date-format";

function Fields({ fields, emptyMessage }: {
  fields: readonly (readonly [string, string | number | null | undefined])[];
  emptyMessage: string;
}) {
  const populated = fields.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (populated.length === 0) return <p className="text-sm leading-6 text-muted-foreground">{emptyMessage}</p>;
  return <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
    {populated.map(([label, value]) => <Fragment key={label}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</dd>
    </Fragment>)}
  </dl>;
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0">
    <h3 className="mb-3 text-sm font-semibold text-primary">{title}</h3>
    {children}
  </section>;
}

export function UserProfileDetails({ user, section }: { user: AdminUserDetails; section: "personal" | "tennis" }) {
  const { personal, player } = user;
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const avatarSrc = player?.avatar_path ? `/admin/users/${user.id}/avatar?v=${encodeURIComponent(player.updated_at)}` : null;
  const fullName = [personal.first_name, personal.last_name].filter(Boolean).join(" ");
  const countries = new Intl.DisplayNames(["en"], { type: "region" });
  return section === "personal" ? <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2 lg:gap-6">
    <ProfileSection title="Personal information">
      {!fullName && !personal.phone && !personal.date_of_birth &&
        <p className="mb-3 text-sm leading-6 text-muted-foreground">No personal details added yet.</p>}
      <Fields emptyMessage="No personal details added yet." fields={[
        ["Full name", fullName || null], ["Email", user.email],
        ["Phone", personal.phone], ["Date of birth", personal.date_of_birth ? formatUserDate(personal.date_of_birth) : null],
      ]} />
    </ProfileSection>
    <div className="min-w-0 border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
      <ProfileSection title="Address">
        <Fields emptyMessage="No address added yet." fields={[
          ["Address line 1", personal.address_line1], ["Address line 2", personal.address_line2],
          ["City", personal.city], ["Postal code", personal.postal_code],
          ["Country", personal.country_code ? countries.of(personal.country_code) : null],
        ]} />
      </ProfileSection>
    </div>
  </div> : <ProfileSection title="Tennis profile">
    <div className="flex min-w-0 flex-col items-start gap-5 sm:flex-row sm:gap-6">
      <div className="w-28 shrink-0">
        <div className="flex size-28 items-center justify-center rounded-control border border-border bg-surface-muted p-2">
          {avatarSrc && failedAvatar !== avatarSrc
            // eslint-disable-next-line @next/next/no-img-element -- Private authenticated avatar endpoint, without image optimization caching.
            ? <img src={avatarSrc} alt="User avatar" className="h-auto max-h-full w-auto max-w-full object-contain" onError={() => setFailedAvatar(avatarSrc)} />
            : <UserRound aria-hidden="true" className="size-9 text-muted-foreground" />}
        </div>
        {(!avatarSrc || failedAvatar === avatarSrc) && <p className="mt-2 text-center text-xs leading-5 text-muted-foreground">
          {avatarSrc ? "Avatar unavailable" : "No avatar uploaded"}
        </p>}
      </div>
      <div className="min-w-0 flex-1">
        <Fields emptyMessage="No tennis profile added yet." fields={[
          ["Display name", player?.display_name], ["Sportya level", player?.sportya_level], ["Internal rating", player?.rating],
          ["Handedness", player?.handedness ? { right: "Right-handed", left: "Left-handed" }[player.handedness] : null],
          ["Backhand", player?.backhand ? { one_handed: "One-handed", two_handed: "Two-handed" }[player.backhand] : null],
          ["Preferred game", player?.preferred_game ? { singles: "Singles", doubles: "Doubles", both: "Both" }[player.preferred_game] : null],
          ["Preferred surface", player?.preferred_surface ? { clay: "Clay", hard: "Hard", grass: "Grass", carpet: "Carpet", any: "Any" }[player.preferred_surface] : null],
          ["Bio", player?.bio], ["Last updated", player ? formatUserDate(player.updated_at) : null],
        ]} />
      </div>
    </div>
  </ProfileSection>;
}
