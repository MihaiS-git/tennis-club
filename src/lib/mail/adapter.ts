import "server-only";

export type MailMessage = {
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
};
export type DeliveryOutcome = "delivered" | "retry" | "uncertain" | "failed";
export type MailDelivery = { outcome: DeliveryOutcome; error?: string };
// Implementations must honour the idempotency key or quarantine ambiguous sends.
// Never return retry if the provider might already have accepted the message.
export interface MailAdapter {
  send(message: MailMessage): Promise<MailDelivery>;
}
