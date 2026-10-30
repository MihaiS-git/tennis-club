import "server-only";
import { normalizeDatabaseError } from "@/lib/db/errors";
import type { BookingCancellationCommandResult } from "./domain";
import { cancelCustomerBookingCommand } from "./commands";

export async function cancelBookingCommand(id: string, actorId: string, admin: boolean, explanation?: string): Promise<BookingCancellationCommandResult> {
  return cancelWithScope(id, actorId, admin ? "admin" : "owner", explanation);
}

// The assigned Coach cancels their lesson under the Admin rules, attributed to the Coach.
export async function cancelLessonAsCoachCommand(id: string, actorId: string): Promise<BookingCancellationCommandResult> {
  return cancelWithScope(id, actorId, "coach");
}

async function cancelWithScope(id: string, actorId: string, scope: Parameters<typeof cancelCustomerBookingCommand>[2], explanation?: string) {
  try {
    return await cancelCustomerBookingCommand(id, actorId, scope, explanation);
  } catch (error: unknown) {
    // Translation occurs only after inTransaction has rolled back.
    throw normalizeDatabaseError(error);
  }
}
