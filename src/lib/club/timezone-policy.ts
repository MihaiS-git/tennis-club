import "server-only";

import type { EntityManager } from "typeorm";
import { listLocationTimezones } from "@/lib/db/repositories/clubs.repository";
import { clubTimezoneError } from "./timezone";

// Call under the existing shared/exclusive configuration fence. Agreement among
// locations is authoritative; no query ordering selects a timezone. Configuration
// candidates also compare inactive current locations, so the first configured
// location establishes the zone even before activation. Scheduling only considers
// active, unarchived locations; archived history never establishes the zone.
export async function readClubTimezoneError(manager: EntityManager,
  candidate?: { id: string; name: string; timezone: string }): Promise<string | null> {
  const locations = await listLocationTimezones(manager, candidate === undefined);
  return clubTimezoneError(candidate
    ? [...locations.filter((location) => location.id !== candidate.id), candidate]
    : locations);
}
