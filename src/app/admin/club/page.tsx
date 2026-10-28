import { readAdminClubContact, readAdminClubSettings } from "@/lib/club/settings";
import { ClubContactForm } from "./contact-form";
import { ClubSettingsForm } from "./settings-form";

export const instant = false;

export default async function AdminClubPage() {
  const [settings, contact] = await Promise.all([readAdminClubSettings(), readAdminClubContact()]);
  return <>
    <h1 className="mb-4 font-heading text-2xl font-semibold text-primary">Club</h1>
    <div className="space-y-6">
      <ClubContactForm contact={contact} />
      <ClubSettingsForm settings={settings} />
    </div>
  </>;
}
