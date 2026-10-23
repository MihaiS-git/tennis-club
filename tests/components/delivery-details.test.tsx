// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeliveryDetails } from "@/app/messages/[messageId]/delivery-details";
const mocks = vi.hoisted(() => ({ retry: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/messages/actions", () => ({ retryMessageDeliveryAction: mocks.retry }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
afterEach(cleanup);
const delivery = { bookingHref: "/admin/bookings/booking", recipientEmail: "guest@example.test", emailType: "Booking confirmed",
  status: "failed" as const, failureReason: "Brevo HTTP 401: Key not found", attempts: 1,
  lastAttempt: "2026-10-23T11:40:00Z", nextAutomaticRetry: null,
  retry: { eligible: true, reason: "Previous request rejected" } };
test("details display operational facts and retry waits for the immediate action", async () => {
  let finish: (value: string) => void = () => {};
  mocks.retry.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  render(<DeliveryDetails messageId="message" delivery={delivery} />);
  expect(screen.getByRole("link", { name: "View booking details" }).getAttribute("href")).toBe(delivery.bookingHref);
  expect(screen.getByText(delivery.recipientEmail)).toBeDefined();
  expect(screen.getByText(delivery.failureReason)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  expect((screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement).disabled).toBe(true);
  finish("Accepted by Brevo. This does not confirm inbox delivery.");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Accepted by Brevo"));
  expect(mocks.retry).toHaveBeenCalledWith("message"); expect(mocks.refresh).toHaveBeenCalled();
});
test("ineligible delivery has a disabled retry with its reason", () => {
  render(<DeliveryDetails messageId="message" delivery={{ ...delivery, retry: { eligible: false, reason: "Brevo already accepted this email." } }} />);
  expect((screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("already accepted");
});
