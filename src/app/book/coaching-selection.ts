import type { PublicLessonStart } from "@/lib/coaching/lesson-availability";

// Public, server-quoted offers for the selected lesson length. No pricing rules
// or coach's private working schedule cross the client boundary.
export type CoachingSelection = {
  locationId: string; programId: string; coachId: string;
  programName: string; coachName: string; durationMinutes: number;
  participantCount: 1 | 2; courtRentalIncluded: boolean; starts: PublicLessonStart[];
};
