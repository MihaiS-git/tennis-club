import type { Metadata } from "next";
import { Trophy } from "lucide-react";
import { readOwnProfile } from "../own-profile";
import { TennisProfileForm } from "../profile-forms";
import { ProfileSection } from "../profile-section";
import { ProfileSettings } from "../profile-settings";

export const metadata: Metadata = { title: "Tennis profile | Tennis Club" };

export default async function TennisProfilePage() {
  const result = await readOwnProfile();
  if ("unavailable" in result) return result.unavailable;
  const { profile } = result;
  return <ProfileSection id="tennis" icon={Trophy} title="Tennis profile" description="Introduce yourself to the club. Tennis information is visible to active signed-in users.">
    <ProfileSettings path="/profile/tennis">
      <TennisProfileForm profile={profile.player ? {
        display_name: profile.player.display_name,
        sportya_level: profile.player.sportya_level,
        rating: profile.player.rating,
        handedness: profile.player.handedness,
        backhand: profile.player.backhand,
        preferred_game: profile.player.preferred_game,
        preferred_surface: profile.player.preferred_surface,
        bio: profile.player.bio,
      } : null} personal={{ first_name: profile.personal.first_name, last_name: profile.personal.last_name }} />
    </ProfileSettings>
  </ProfileSection>;
}
