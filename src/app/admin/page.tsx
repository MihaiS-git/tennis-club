import { redirect } from "next/navigation";

import { requireActiveAdmin } from "@/lib/admin/authorization";

export const instant = false;

export default async function AdminPage() {
  await requireActiveAdmin();
  redirect("/admin/locations");
}
