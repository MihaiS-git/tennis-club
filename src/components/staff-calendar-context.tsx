"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { OperationalChangeInput } from "@/lib/bookings/operational-policy";
import type { ReservationSelection } from "@/lib/reservations/domain";
import type { ReservationTimetableDay } from "./reservation-timetable";
import type { TimelineCellState } from "./court-timeline-grid";

type StaffCalendarState = {
  active: boolean; start: (id: string) => void;
  navigate: (locationId: string, date: string) => void;
  target: OperationalChangeInput | null;
  pending: boolean; loading: boolean; day: ReservationTimetableDay<TimelineCellState> | null;
  selection: ReservationSelection | null; duration: number;
  original?: { courtId: string; startMinute: number; endMinute: number };
  choose: (courtId: string, startMinute: number) => void; toolbar: ReactNode;
};
export const StaffCalendarContext = createContext<StaffCalendarState | null>(null);
export const useStaffCalendar = () => useContext(StaffCalendarContext);
