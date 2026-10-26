import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { findPersonalInformationByUserId } from "@/lib/db/repositories/users.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import type { BookingContact } from "./domain";

const contactRowSchema = z.object({ firstName: z.string().nullable(), lastName: z.string().nullable(), phone: z.string().nullable() });

// Reads only the owner's personal information; an unavailable profile leaves the contact fields empty.
async function readContactInformation(userId: string) {
  let personal;
  try {
    personal = await findPersonalInformationByUserId((await getDataSource()).manager, userId);
  } catch (error: unknown) {
    const databaseError = normalizeDatabaseError(error);
    logger.error({ event: "profile.load_failed", kind: databaseError.kind, code: databaseError.sqlState }, "Failed to load profile");
    return null;
  }
  if (!personal) {
    logger.error({ event: "profile.load_failed" }, "Failed to load profile");
    return null;
  }
  const parsed = contactRowSchema.safeParse(personal);
  if (!parsed.success) {
    logger.error({ event: "profile.invalid_data" }, "Invalid profile data");
    return null;
  }
  return parsed.data;
}

export async function bookingContactPrefill(client?: Awaited<ReturnType<typeof createClient>>): Promise<BookingContact> {
  const reader = client ?? await createClient();
  const account = await readCurrentAccount(reader);
  if (account.state !== "active") return { customerName: "", customerEmail: "", customerPhone: "" };
  const personal = await readContactInformation(account.userId);
  const name = [personal?.firstName, personal?.lastName].filter(Boolean).join(" ").trim();
  return { customerName: name,
    customerEmail: account.email, customerPhone: personal?.phone ?? "" };
}
