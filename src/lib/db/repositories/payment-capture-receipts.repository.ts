import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { paymentProviderSchema } from "@/lib/payments/domain";
import { PaymentCaptureReceiptEntity } from "../entities/payment-capture-receipt.entity";
import { PaymentAttemptEntity } from "../entities/payment-attempt.entity";

const captureReceiptSchema = z.object({
  id: z.uuid(), payment_attempt_id: z.uuid(), provider: paymentProviderSchema,
  provider_payment_id: z.string().min(1).max(255), provider_capture_id: z.string().min(1).max(255),
  amount_minor: z.number().int().positive(), currency: z.enum(locationCurrencies),
});
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>;
export type CaptureReceiptInput = Omit<CaptureReceipt, "id">;

const projection = `id,payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency`;

export async function recordCaptureReceipt(manager: EntityManager, input: CaptureReceiptInput): Promise<CaptureReceipt> {
  const rows: unknown = await manager.query(
    `INSERT INTO public.payment_capture_receipts
      (payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(provider,provider_capture_id) DO UPDATE SET last_observed_at=clock_timestamp()
       WHERE payment_capture_receipts.payment_attempt_id=excluded.payment_attempt_id
         AND payment_capture_receipts.provider_payment_id=excluded.provider_payment_id
         AND payment_capture_receipts.amount_minor=excluded.amount_minor
         AND payment_capture_receipts.currency=excluded.currency
     RETURNING ${projection}`,
    [input.payment_attempt_id,input.provider,input.provider_payment_id,input.provider_capture_id,input.amount_minor,input.currency],
  );
  const receipt = z.array(captureReceiptSchema).max(1).parse(rows)[0];
  if (!receipt) throw new Error("Changed provider capture evidence.");
  return receipt;
}

export async function listCaptureReceipts(manager: EntityManager, bookingId: string, attemptId?: string) {
  const query = manager.getRepository(PaymentCaptureReceiptEntity).createQueryBuilder("receipt")
    .innerJoin(PaymentAttemptEntity, "attempt", "attempt.id=receipt.paymentAttemptId")
    .where("attempt.bookingId=:bookingId", { bookingId }).orderBy("receipt.paymentAttemptId").addOrderBy("receipt.id");
  if (attemptId) query.andWhere("attempt.id=:attemptId", { attemptId });
  return query.getMany();
}

export async function lockCaptureReceiptsForAttempt(manager: EntityManager, attemptId: string) {
  return manager.getRepository(PaymentCaptureReceiptEntity).createQueryBuilder("receipt")
    .where("receipt.paymentAttemptId=:attemptId", { attemptId }).orderBy("receipt.id").setLock("pessimistic_write").getMany();
}
