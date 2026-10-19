import { requireActiveAdmin } from "@/lib/admin/authorization";

import { AdminPageHeader } from "@/components/admin-page-controls";

export const instant = false;

export default async function CoachingLayout({ children }: { children: React.ReactNode }) {
  await requireActiveAdmin();
  return <>
    <AdminPageHeader title="Coaching" description="Configure coaching programs, public coach profiles and coaching prices shown on the public Coaching page, and coach availability." />
    {children}
  </>;
}
