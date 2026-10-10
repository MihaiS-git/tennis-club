"use client";
import { useState } from "react";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { OpeningHours } from "./opening-hours";

export function LocationOpeningHours({ locationId, intervals }: { locationId: string; intervals: OpeningInterval[] }) {
  // Server renders may deserialize the same schedule into a new array. Only a
  // changed server snapshot should supersede the committed mutation response.
  const source = JSON.stringify(intervals);
  const [state, setState] = useState({ source, current: intervals });
  if (state.source !== source) setState({ source, current: intervals });
  return <OpeningHours locationId={locationId} intervals={state.source === source ? state.current : intervals}
    onUpdated={(current) => setState({ source, current })} />;
}
