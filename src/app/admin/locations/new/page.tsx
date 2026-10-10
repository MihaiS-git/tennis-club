import { AdminPageHeader } from "@/components/admin-page-controls";
import { LocationForm } from "../location-form";

export const instant = false;

export default function NewLocationPage() {
  return <>
    <AdminPageHeader title="Create location" description="Add a physical club location and its operating details." />
    <section className="rounded-control border border-border bg-surface p-4 sm:p-6">
      <LocationForm />
    </section>
  </>;
}
