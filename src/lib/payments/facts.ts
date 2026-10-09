import { z } from "zod";

const instant = z.string();
export const paymentFactSchema = z.object({ id: z.uuid(), booking_id: z.uuid(), method: z.string(), provider: z.string().nullable(),
  provider_payment_id: z.string().nullable(), amount_minor: z.number().int(), currency: z.string(), status: z.string(),
  expires_at: instant.nullable(), created_at: instant });
export const providerEventFactSchema = z.object({ provider: z.string(), event_id: z.string(), attempt_id: z.uuid(),
  provider_payment_id: z.string(), outcome: z.string(), settlement_result: z.string(), reconciliation_required: z.boolean(),
  amount_minor: z.number().int(), currency: z.string(), resolved_at: instant.nullable(), resolved_by_user_id: z.uuid().nullable() });
