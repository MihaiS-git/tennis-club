import { requireActiveAdmin } from "@/lib/admin/authorization";

export const instant = false;

export default async function AdminSectionLayout({ children }: { children: React.ReactNode }) {
  await requireActiveAdmin();
  return children;
}
