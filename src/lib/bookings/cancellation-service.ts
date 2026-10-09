import "server-only";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { cancelCustomerBookingCommand } from "./commands";

export async function cancelBookingCommand(id: string, actorId: string, admin: boolean, refundChoice: boolean | null) {
  try {
    return await cancelCustomerBookingCommand(id, actorId, admin ? "admin" : "owner", refundChoice);
  } catch (error: unknown) {
    // Translation occurs only after inTransaction has rolled back.
    throw normalizeDatabaseError(error);
  }
}
