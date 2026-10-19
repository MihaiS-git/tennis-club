import { requireActiveAdmin } from "@/lib/admin/authorization";

export const instant = false;

export default async function AdminBookingsLayout({ children }: { children: React.ReactNode }) {
  await requireActiveAdmin();
  return children;
}
