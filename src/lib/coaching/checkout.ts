import "server-only";

import { createCoachingBooking } from "./booking";
import { startCommittedCheckout } from "@/lib/payments/committed-checkout";

// The /book coaching Server Action delegates here. Creation validates the
// verified customer and selected provider; Stripe starts only after commit.
export async function commitCoachingCheckout(input: unknown, reader?: Parameters<typeof createCoachingBooking>[1]) {
  const result = await createCoachingBooking(input, reader);
  if (!result.ok) return result;
  return startCommittedCheckout(result);
}
