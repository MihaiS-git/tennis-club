// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BookCourtLink, startAnotherBookingEvent } from "@/components/book-court-link";

vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
afterEach(cleanup);

it.each(["/profile"])("keeps ordinary booking navigation from %s", pathname => {
  window.history.replaceState(null, "", pathname);
  const restart = vi.fn();
  window.addEventListener(startAnotherBookingEvent, restart);
  render(<nav onClick={event => event.preventDefault()}><BookCourtLink className="booking-button" /></nav>);
  const link = screen.getByRole("link", { name: "Book a court" });
  expect(link.getAttribute("href")).toBe("/book");
  fireEvent.click(link);
  expect(restart).not.toHaveBeenCalled();
  window.removeEventListener(startAnotherBookingEvent, restart);
});

it.each(["ctrlKey", "metaKey", "shiftKey", "altKey"])("does not restart the current booking for a %s click", modifier => {
  window.history.replaceState(null, "", "/book");
  const restart = vi.fn();
  window.addEventListener(startAnotherBookingEvent, restart);
  render(<nav onClick={event => event.preventDefault()}><BookCourtLink className="" /></nav>);
  fireEvent.click(screen.getByRole("link", { name: "Book a court" }), { [modifier]: true });
  expect(restart).not.toHaveBeenCalled();
  window.removeEventListener(startAnotherBookingEvent, restart);
});
