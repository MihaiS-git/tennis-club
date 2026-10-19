// Read models derive includes_coaching from the current stored revision's coach
// reference. Display names and prices never determine the booking type.
export type BookingTypeSnapshot = {
  includes_coaching?: boolean;
  coach_name?: string | null;
  coaching_program_name?: string | null;
};
export type BookingType = "court" | "coaching";
export const bookingTypeLabels: Record<BookingType, string> = { court: "Court", coaching: "Coaching" };

export function bookingType(booking: BookingTypeSnapshot): BookingType {
  return booking.includes_coaching ? "coaching" : "court";
}
export function bookingTypeLabel(booking: BookingTypeSnapshot) {
  return bookingTypeLabels[bookingType(booking)];
}
export function bookingTypeDetail(booking: BookingTypeSnapshot) {
  return bookingType(booking) === "coaching"
    ? [booking.coach_name, booking.coaching_program_name].filter(Boolean).join(" · ") : undefined;
}
