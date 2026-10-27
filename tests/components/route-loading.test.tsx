// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ManagementShellFallback } from "@/components/management-shell";
import LoadingBooking from "@/app/admin/bookings/[bookingId]/loading";
import LoadingBookings from "@/app/admin/bookings/loading";
import LoadingAdminReservation from "@/app/admin/bookings/reservations/[reservationId]/loading";
import LoadingCoaching from "@/app/admin/coaching/loading";
import LoadingLocation from "@/app/admin/locations/[locationId]/loading";
import LoadingTransaction from "@/app/admin/payments/transactions/[kind]/[transactionId]/loading";
import LoadingUser from "@/app/admin/users/[userId]/loading";
import MessagesLoading from "@/app/messages/loading";
import LoadingMessage from "@/app/messages/[messageId]/loading";
import ProfileLoading from "@/app/profile/loading";

afterEach(cleanup);

it("keeps the management main area in place without role-specific navigation", () => {
  const { container } = render(<ManagementShellFallback />);
  expect(container.querySelector("main.flex-1")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Loading management area…");
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  // Lets globals.css keep the footer unpainted until the loaded page height is known.
  expect(container.querySelectorAll("[data-defers-footer]")).toHaveLength(1);
});

it.each([
  ["booking", LoadingBooking, "Loading booking details…"],
  ["bookings", LoadingBookings, "Loading bookings…"],
  ["Admin reservation", LoadingAdminReservation, "Loading reservation details…"],
  ["coaching", LoadingCoaching, "Loading coaching…"],
  ["location", LoadingLocation, "Loading location…"],
  ["transaction", LoadingTransaction, "Loading transaction…"],
  ["user", LoadingUser, "Loading user details…"],
  ["notifications", MessagesLoading, "Loading notifications…"],
  ["notification", LoadingMessage, "Loading notification…"],
  ["profile", ProfileLoading, "Loading your profile…"],
] as const)("shows the %s route fallback as the one page-loading status", (_, Loading, label) => {
  const { container } = render(<Loading />);
  const status = screen.getByRole("status");
  expect(container.firstElementChild).toBe(status);
  expect(status.textContent).toBe(label);
  expect(status.className).toContain("min-h-60");
  expect(status.querySelector("svg")?.getAttribute("class")).toContain("motion-safe:animate-spin");
  // No per-page skeletons or placeholder data.
  expect(container.querySelector(".animate-pulse, [class*='animate-pulse']")).toBeNull();
});
