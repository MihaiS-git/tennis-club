import { readAdminClubSettings } from "@/lib/club/settings";
import { ClubSettingsForm } from "./settings-form";

export const instant = false;

export default async function AdminClubPage() {
  const settings = await readAdminClubSettings();
  return <>
    <h1 className="mb-4 font-heading text-2xl font-semibold text-primary">Club</h1>
    <ClubSettingsForm settings={settings} />
  </>;
}
