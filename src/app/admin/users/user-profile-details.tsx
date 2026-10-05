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

export function UserProfileDetails({ user }: { user: AdminUserDetails }) {
  const { personal, player } = user;
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const avatarSrc = player?.avatar_path ? `/admin/users/${user.id}/avatar?v=${encodeURIComponent(player.updated_at)}` : null;
  const fullName = [personal.first_name, personal.last_name].filter(Boolean).join(" ");
  const countries = new Intl.DisplayNames(["en"], { type: "region" });
  return <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2 xl:grid-cols-3">
    <ProfileSection title="Profile">
      <dl className={fieldsClassName}>
        <Fields fields={[
          ["Display name", player?.display_name], ["Full name", fullName || null], ["Email", user.email],
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
    <div className="min-w-0 md:col-span-2 xl:col-span-1">
      <ProfileSection title="Tennis profile">
        <div className="grid items-start gap-4 md:grid-cols-[9rem_minmax(0,1fr)] xl:grid-cols-1">
          <div className="flex justify-center">
            {avatarSrc && failedAvatar !== avatarSrc
              // eslint-disable-next-line @next/next/no-img-element -- Private authenticated avatar endpoint, without image optimization caching.
              ? <img src={avatarSrc} alt="User avatar" width={144} height={144} className="size-36 shrink-0 rounded-full object-contain" onError={() => setFailedAvatar(avatarSrc)} />
              : <span className="flex size-36 shrink-0 items-center justify-center rounded-full bg-surface-muted"><UserRound aria-hidden="true" className="size-16 text-muted-foreground" /></span>}
          </div>
          <dl className={fieldsClassName}>
            <Fields fields={[
              ["Sportya level", player?.sportya_level], ["Internal rating", player?.rating],
              ["Handedness", player?.handedness ? { right: "Right-handed", left: "Left-handed" }[player.handedness] : null],
              ["Backhand", player?.backhand ? { one_handed: "One-handed", two_handed: "Two-handed" }[player.backhand] : null],
              ["Preferred game", player?.preferred_game ? { singles: "Singles", doubles: "Doubles", both: "Both" }[player.preferred_game] : null],
              ["Preferred surface", player?.preferred_surface ? { clay: "Clay", hard: "Hard", grass: "Grass", carpet: "Carpet", any: "Any" }[player.preferred_surface] : null],
              ["Bio", player?.bio], ["Last updated", player ? formatUserDate(player.updated_at) : null],
            ]} />
          </dl>
        </div>
      </ProfileSection>
    </div>
  </div>;
}
