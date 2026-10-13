"use client";
import { useState } from "react";
import type { OpeningInterval, OpeningHoursSchedule } from "@/lib/admin/opening-hours-validation";
import { OpeningHours } from "./opening-hours";

export function LocationOpeningHours({ locationId, intervals, schedules = [], today }: { locationId: string; intervals: OpeningInterval[]; schedules?: OpeningHoursSchedule[]; today?: string }) {
  // Server renders may deserialize the same schedule into a new array. Only a
  // changed server snapshot should supersede the committed mutation response.
  const source = JSON.stringify({ intervals, schedules });
  const [state, setState] = useState({ source, current: intervals, schedules });
  if (state.source !== source) setState({ source, current: intervals, schedules });
  return <OpeningHours locationId={locationId} intervals={state.source === source ? state.current : intervals}
    schedules={state.source === source ? state.schedules : schedules} today={today}
    onUpdated={(current, updatedSchedules) => setState({ source, current, schedules: updatedSchedules ?? schedules })} />;
}
