import { redirect } from "next/navigation";

export const instant = false;

export default function CoachPage() {
  redirect("/coach/availability");
}
