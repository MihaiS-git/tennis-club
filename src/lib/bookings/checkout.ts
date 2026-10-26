import "server-only";
import { customerBookingInputSchema } from "./domain";
import { createCustomerBooking } from "./service";
import { activeOnlinePaymentProvider } from "@/lib/payments/settings";
import { supportsOnlineCheckout } from "@/lib/payments/providers";
import { startCommittedCheckout } from "@/lib/payments/committed-checkout";

// Provider initialization starts only after the TypeORM creation transaction commits.
export async function commitCustomerCheckout(input: unknown) {
  const intent = customerBookingInputSchema.parse(input);
  if (intent.paymentMethod === "online" && !supportsOnlineCheckout(await activeOnlinePaymentProvider()))
    return { ok: false as const, message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." };
  const result = await createCustomerBooking(intent);
  if (!result.ok) return result;
  if (result.status === "confirmed") return result;
  return startCommittedCheckout(result);
}
