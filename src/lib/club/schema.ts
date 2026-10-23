import { z } from "zod";

export const clubSettingsSchema = z.strictObject({
  officialEmail: z.string().trim().max(254).pipe(z.email()),
  senderName: z.string().trim().min(1, "Enter an email sender name.").max(100).regex(/^[^\r\n]+$/),
  emailsEnabled: z.boolean(),
});
export type ClubSettings = z.infer<typeof clubSettingsSchema>;
