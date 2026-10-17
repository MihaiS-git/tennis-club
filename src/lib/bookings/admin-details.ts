import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { getDataSource } from "@/lib/db/data-source";
import { findAdminBookingDetails } from "@/lib/db/repositories/bookings.repository";

export async function getAdminBookingDetails(input: unknown) {
  await requireActiveAdmin();
  const id = z.uuid().safeParse(input);
  if (!id.success) return null;
  return findAdminBookingDetails((await getDataSource()).manager, id.data);
}

export type AdminBookingDetails = NonNullable<Awaited<ReturnType<typeof getAdminBookingDetails>>>;
