import "server-only";

import { revalidatePath } from "next/cache";

/** Call only after a successful booking or direct reservation mutation. */
export function revalidateCourtActivity(mutation: "create" | "edit" | "cancel") {
  revalidatePath("/book");
  revalidatePath("/reservations");
  // These are shared route paths, including when an Admin changes another owner's activity.
  revalidatePath("/my-activity/bookings");
  // Existing edits keep reservations in Upcoming; cancellation moves them to History.
  if (mutation === "cancel") revalidatePath("/my-activity/bookings/history");
}
