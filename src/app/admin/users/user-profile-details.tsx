"use client";

import { Fragment, useState, type ReactNode } from "react";
import { UserRound } from "lucide-react";
import type { AdminUserDetails } from "@/lib/admin/users";
import { formatUserDate } from "./date-format";

function Fields({ fields }: { fields: readonly (readonly [string, string | number | null | undefined])[] }) {
  return fields.map(([label, value]) => <Fragment key={label}>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{value === "" ? "—" : value ?? "—"}</dd>
  </Fragment>);
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0">
    <h3 className="mb-3 text-sm font-semibold text-primary">{title}</h3>
    {children}
  </section>;
}

const fieldsClassName = "grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm";

export function UserProfileDetails({ user, section }: { user: AdminUserDetails; section: "personal" | "tennis" }) {
  const { personal, player } = user;
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const avatarSrc = player?.avatar_path ? `/admin/users/${user.id}/avatar?v=${encodeURIComponent(player.updated_at)}` : null;
  const fullName = [personal.first_name, personal.last_name].filter(Boolean).join(" ");
  const countries = new Intl.DisplayNames(["en"], { type: "region" });
  return section === "personal" ? <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
    <ProfileSection title="Personal information">
      <dl className={fieldsClassName}>
        <Fields fields={[
          ["Full name", fullName || null], ["Email", user.email],
          ["Phone", personal.phone], ["Date of birth", personal.date_of_birth ? formatUserDate(personal.date_of_birth) : null],
        ]} />
      </dl>
    </ProfileSection>
    <ProfileSection title="Address">
      <dl className={fieldsClassName}>
        <Fields fields={[
          ["Address line 1", personal.address_line1], ["Address line 2", personal.address_line2],
          ["City", personal.city], ["Postal code", personal.postal_code],
          ["Country", personal.country_code ? countries.of(personal.country_code) : null],
        ]} />
      </dl>
    </ProfileSection>
  </div> : <div className="min-w-0">
      <ProfileSection title="Tennis profile">
        <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-h-48 items-center justify-center rounded-control border border-border bg-surface-muted p-3">
            {avatarSrc && failedAvatar !== avatarSrc
              // eslint-disable-next-line @next/next/no-img-element -- Private authenticated avatar endpoint, without image optimization caching.
              ? <img src={avatarSrc} alt="User avatar" className="h-auto max-h-96 w-auto max-w-full object-contain" onError={() => setFailedAvatar(avatarSrc)} />
              : <span className="flex flex-col items-center gap-2 text-sm text-muted-foreground"><UserRound aria-hidden="true" className="size-16" />{avatarSrc ? "Avatar unavailable" : "No avatar uploaded"}</span>}
          </div>
          <dl className={fieldsClassName}>
            <Fields fields={[
              ["Display name", player?.display_name], ["Sportya level", player?.sportya_level], ["Internal rating", player?.rating],
              ["Handedness", player?.handedness ? { right: "Right-handed", left: "Left-handed" }[player.handedness] : null],
              ["Backhand", player?.backhand ? { one_handed: "One-handed", two_handed: "Two-handed" }[player.backhand] : null],
              ["Preferred game", player?.preferred_game ? { singles: "Singles", doubles: "Doubles", both: "Both" }[player.preferred_game] : null],
              ["Preferred surface", player?.preferred_surface ? { clay: "Clay", hard: "Hard", grass: "Grass", carpet: "Carpet", any: "Any" }[player.preferred_surface] : null],
              ["Bio", player?.bio], ["Last updated", player ? formatUserDate(player.updated_at) : null],
            ]} />
          </dl>
        </div>
      </ProfileSection>
  </div>;
}
