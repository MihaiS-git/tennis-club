import "server-only";

import nodemailer from "nodemailer";
import { z } from "zod";
import type { MailAdapter, MailDelivery } from "./adapter.ts";

export function smtpFailure(error: unknown): MailDelivery {
  const parsed = z.object({ command: z.string().optional(), responseCode: z.number().optional() }).safeParse(error);
  if (!parsed.success) return { outcome: "uncertain", error: "smtp_acknowledgement_unknown" };
  const { command, responseCode } = parsed.data;
  // Explicit SMTP rejection guarantees non-acceptance, including after DATA.
  if (responseCode && responseCode >= 400 && responseCode < 600)
    return { outcome: responseCode < 500 ? "retry" : "failed", error: `smtp_rejected_${responseCode}` };
  if (command && ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO"].includes(command))
    return { outcome: "retry", error: "smtp_before_data_failed" };
  return { outcome: "uncertain", error: "smtp_acknowledgement_unknown" };
}

export function createSmtpMailAdapter(): MailAdapter {
  const config = z.object({
    host: z.string().min(1), port: z.coerce.number().int().min(1).max(65535),
    from: z.email(), secure: z.enum(["true", "false"]),
    user: z.string().optional(), password: z.string().optional(),
  }).parse({ host: process.env.BOOKING_SMTP_HOST, port: process.env.BOOKING_SMTP_PORT,
    from: process.env.BOOKING_MAIL_FROM, secure: process.env.BOOKING_SMTP_SECURE ?? "false",
    user: process.env.BOOKING_SMTP_USER, password: process.env.BOOKING_SMTP_PASSWORD });
  if (Boolean(config.user) !== Boolean(config.password)) throw new Error("Both SMTP credentials are required.");
  const transport = nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.secure === "true",
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({ from: config.from, to: message.to,
          envelope: { from: config.from, to: [message.to] },
          subject: message.subject, text: message.text,
          messageId: `<booking-${message.idempotencyKey}@${config.from.split("@")[1]}>` });
        return { outcome: "delivered" };
      } catch (error) { return smtpFailure(error); }
    },
  };
}
