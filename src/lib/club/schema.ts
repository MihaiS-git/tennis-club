import { z } from "zod";

export const clubSettingsSchema = z.strictObject({
  officialEmail: z.string().trim().max(254).pipe(z.email()),
  senderName: z.string().trim().min(1, "Enter an email sender name.").max(100).regex(/^[^\r\n]+$/),
  emailsEnabled: z.boolean(),
});
export type ClubSettings = z.infer<typeof clubSettingsSchema>;

// Public club contact details shown on the website. Separate from the Brevo sender above;
// either value may be empty, in which case it is not published.
const phonePattern = /^\+?[0-9(][0-9 ().-]*[0-9]$/;
export const clubContactSchema = z.strictObject({
  contactEmail: z.string().trim().max(254).pipe(z.union([z.literal(""), z.email()])),
  contactPhone: z.string().trim().max(30).refine(phone => phone === "" || (phonePattern.test(phone)
    && /^\d{6,15}$/.test(phone.replace(/\D/g, ""))), "Enter a telephone number of 6–15 digits."),
});
export type ClubContact = z.infer<typeof clubContactSchema>;

// The dialable form of a saved telephone number: formatting removed, a leading + kept.
export function telephoneHref(phone: string) {
  return `tel:${phone.trim().startsWith("+") ? "+" : ""}${phone.replace(/\D/g, "")}`;
}
