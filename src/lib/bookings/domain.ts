import { z } from "zod";
import { paymentMethodSchema } from "@/lib/payments/domain";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { minorAmountSchema } from "@/lib/pricing/money";

// Internal application result. A cancellation that must return captured funds is
// a pending request: the booking stays confirmed until its refunds are verified.
export type BookingCancellationCommandResult =
  | { outcome: "cancelled"; refundIds: string[] }
  | { outcome: "cancellation_pending"; adjustmentId: string; refundIds: string[] }
  | { outcome: "change_pending" }
  | { outcome: "unavailable" }
  | { outcome: "inactive" }
  | { outcome: "started" }
  | { outcome: "notice_required" };

export type BookingContact = { customerName: string; customerEmail: string; customerPhone: string };

// Customer contact snapshot rules shared by court and coaching bookings.
export const bookingContactShape = {
  customerName: z.string({ error: "Name is required." }).trim()
    .min(1, "Name is required.").max(200, "Name must be 200 characters or fewer."),
  customerEmail: z.string({ error: "Email address is required." }).trim()
    .min(1, "Email address is required.").email("Enter a valid email address.")
    .max(320, "Email address must be 320 characters or fewer."),
  customerPhone: z.string({ error: "Phone number is required." }).trim()
    .min(1, "Phone number is required.").max(50, "Phone number must be 50 characters or fewer.")
    .refine((value) => !value || (/^\+?[0-9 ()-]+$/.test(value) && /[0-9]/.test(value)),
      "Enter a valid phone number, for example +40 712 345 678."),
};

export const customerBookingInputSchema = z.strictObject({
  paymentMethod: paymentMethodSchema.default("online"),
  courtId: z.uuid(),
  date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  ...bookingContactShape,
  expectedTotalAmountMinor: minorAmountSchema,
  expectedCurrency: z.enum(locationCurrencies),
}).refine((value) => value.startMinute % 30 === 0 && value.endMinute % 30 === 0
  && value.endMinute - value.startMinute >= 60,
{ path: ["startMinute"], message: "Choose at least 60 minutes in 30-minute steps." });

type HoldInterval = { courtId: string; date: string; startMinute: number; endMinute: number };
type AdjustmentHoldFragment = HoldInterval & { coachUserId?: string };

// Reserve only the target pieces outside the already-confirmed occupancy. The
// original lesson keeps protecting its coach at its own date and time on any
// court, so a coaching target holds the coach only outside that time; inside
// it a different court is held without the coach, the same court not at all.
export function adjustmentHoldFragments(original: HoldInterval, target: HoldInterval, coachUserId?: string | null): AdjustmentHoldFragment[] {
  const outside = (excluded: boolean) => excluded ? [[target.startMinute, Math.min(target.endMinute, original.startMinute)],
    [Math.max(target.startMinute, original.endMinute), target.endMinute]] : [[target.startMinute, target.endMinute]];
  const fragment = ([startMinute, endMinute]: number[], coach?: string) => ({
    courtId: target.courtId, date: target.date, startMinute, endMinute, ...(coach ? { coachUserId: coach } : {}),
  });
  const sameDate = original.date === target.date, sameCourt = original.courtId === target.courtId;
  if (!coachUserId) return outside(sameDate && sameCourt).filter(([start, end]) => end > start).map((interval) => fragment(interval));
  const overlap = sameDate && !sameCourt
    ? [[Math.max(target.startMinute, original.startMinute), Math.min(target.endMinute, original.endMinute)]] : [];
  return [...outside(sameDate).filter(([start, end]) => end > start).map((interval) => fragment(interval, coachUserId)),
    ...overlap.filter(([start, end]) => end > start).map((interval) => fragment(interval))]
    .sort((a, b) => a.startMinute - b.startMinute);
}

// Changes that return money keep the original booking until every refund is
// verified. Increases are payment-backed and settle through the payment workflow.
export function refundBackedAdjustment(adjustment: { kind: "reschedule" | "cancellation"; newTotal: number; originalTotal: number }) {
  return adjustment.kind === "cancellation" || adjustment.newTotal < adjustment.originalTotal;
}

// Every required obligation must succeed; partial repayment cannot be undone.
// Verified definitive failure of every obligation (no money moved) abandons the change.
export function refundBackedOutcome(statuses: readonly string[]): "waiting" | "apply" | "abandon" {
  if (statuses.length === 0) return "waiting";
  if (statuses.every(status => status === "succeeded")) return "apply";
  return statuses.every(status => status === "failed") ? "abandon" : "waiting";
}
