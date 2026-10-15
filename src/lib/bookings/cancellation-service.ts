import "server-only";
import { normalizeDatabaseError } from "@/lib/db/errors";
import type { BookingCancellationCommandResult } from "./domain";
import { cancelCustomerBookingCommand } from "./commands";

export async function cancelBookingCommand(id: string, actorId: string, admin: boolean): Promise<BookingCancellationCommandResult> {
  try {
    return await cancelCustomerBookingCommand(id, actorId, admin ? "admin" : "owner");
  } catch (error: unknown) {
    // Translation occurs only after inTransaction has rolled back.
    throw normalizeDatabaseError(error);
  }
}
