import { redirect } from "next/navigation";

export const instant = false;

export default function AdminCoachingPage() {
  redirect("/admin/coaching/programs");
}
