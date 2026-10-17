import type { Metadata } from "next";
import { IdCard } from "lucide-react";
import { readOwnProfile } from "../own-profile";
import { PersonalInformationForm } from "../profile-forms";
import { ProfileSection } from "../profile-section";
import { ProfileSettings } from "../profile-settings";

export const metadata: Metadata = { title: "Personal information | Tennis Club" };

export default async function PersonalInformationPage() {
  const result = await readOwnProfile();
  if ("unavailable" in result) return result.unavailable;
  return <ProfileSection id="personal" icon={IdCard} title="Personal information" description="Your contact and address details stay private.">
    <ProfileSettings path="/profile/personal"><PersonalInformationForm profile={result.profile.personal} /></ProfileSettings>
  </ProfileSection>;
}
