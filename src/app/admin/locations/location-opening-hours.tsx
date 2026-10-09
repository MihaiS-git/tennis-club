"use client";
import { useState } from "react";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { OpeningHours } from "./opening-hours";

export function LocationOpeningHours({ locationId, intervals }: { locationId: string; intervals: OpeningInterval[] }) {
  const [state, setState] = useState({ source: intervals, current: intervals });
  return <OpeningHours locationId={locationId} intervals={state.source === intervals ? state.current : intervals}
    onUpdated={(current) => setState({ source: intervals, current })} />;
}
