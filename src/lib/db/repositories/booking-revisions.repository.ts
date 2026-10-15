import "server-only";
import type { EntityManager } from "typeorm";
import type { RevisionSnapshot } from "@/lib/bookings/revision";
import { BookingRevisionEntity } from "../entities/booking-revision.entity";
import { BookingEntity } from "../entities/booking.entity";

export class BookingRevisionFenceError extends Error {}

export function findRevision(manager: EntityManager, id: string) {
  return manager.getRepository(BookingRevisionEntity).findOneByOrFail({ id });
}
export function findInitialRevision(manager: EntityManager, bookingId: string) {
  return manager.getRepository(BookingRevisionEntity).findOneByOrFail({ bookingId, revisionNumber: 1 });
}
export function findRevisionOperation(manager: EntityManager, bookingId: string, operationKey: string) {
  return manager.getRepository(BookingRevisionEntity).findOneBy({ bookingId, operationKey });
}
export async function insertRevision(manager: EntityManager, revision: RevisionSnapshot) {
  await manager.getRepository(BookingRevisionEntity).insert(revision);
}
// Caller owns aggregate locks and the transaction. A failed pointer/deadline fence
// throws so provisional revision and occupancy writes cannot commit.
export async function advanceRevision(manager: EntityManager, input: {
  revision: RevisionSnapshot; previousId: string; status: BookingEntity["status"]; deadline?: string | null;
}) {
  await insertRevision(manager, input.revision);
  const result = await manager.getRepository(BookingEntity).createQueryBuilder().update()
    .set({ currentRevisionId: input.revision.id, status: input.status, updatedAt: input.revision.recordedAt })
    .where("id=:id AND current_revision_id=:previous", { id: input.revision.bookingId, previous: input.previousId })
    .andWhere("(:deadline::timestamptz IS NULL OR clock_timestamp()<:deadline::timestamptz)", { deadline: input.deadline ?? null }).execute();
  if (result.affected !== 1) throw new BookingRevisionFenceError("Booking revision pointer or deadline changed");
}
