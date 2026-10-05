// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useEffect, type ReactNode } from "react";

const { pay, status, elements } = vi.hoisted(() => ({ pay: vi.fn(), status: vi.fn(), elements: {} }));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn() }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => children,
  useStripe: () => ({ confirmPayment: pay }), useElements: () => elements,
  PaymentElement: ({ onReady }: { onReady: () => void }) => {
    useEffect(() => { onReady(); }, [onReady]);
    return <input aria-label="Card" />;
  },
}));
vi.mock("@/app/book/actions", () => ({ readCheckoutStatusAction: status }));
import { OnlinePayment } from "@/app/book/online-payment";

const props = { checkout: { attemptId: "c9000000-0000-4000-8000-000000000011", token: "a".repeat(64),
  presentation: { kind: "stripe" as const, publishableKey: "pk_test_Fixture", clientSecret: "pi_fixture_secret" } },
  holdExpiresAt: "2099-10-15T10:00:00Z", onConfirmed: vi.fn() };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test("a declined card leaves the same payment element available for another attempt", async () => {
  status.mockResolvedValue({ ok: true, status: "pending_payment" });
  pay.mockResolvedValueOnce({ error: { message: "Your card was declined." } }).mockResolvedValueOnce({});
  render(<OnlinePayment {...props} />);
  const card = screen.getByLabelText("Card");
  fireEvent.change(card, { target: { value: "declined card" } });
  fireEvent.submit(screen.getByRole("form", { name: "Online payment" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Your card was declined."));
  expect(screen.getByLabelText("Card")).toBe(card);
  expect((screen.getByRole("button", { name: "Pay and confirm booking" }) as HTMLButtonElement).disabled).toBe(false);
  expect(props.onConfirmed).not.toHaveBeenCalled();
  fireEvent.change(card, { target: { value: "another card" } });
  fireEvent.submit(screen.getByRole("form", { name: "Online payment" }));
  await waitFor(() => expect(pay).toHaveBeenCalledTimes(2));
  expect(pay.mock.calls.map(call => call[0].elements)).toEqual([elements, elements]);
  expect(status.mock.calls.every(call => call[0].attemptId === props.checkout.attemptId)).toBe(true);
});

test.each(["expired", "failed"])("a terminal %s checkout stops accepting cards without confirming a booking", async terminal => {
  status.mockResolvedValue({ ok: true, status: terminal });
  render(<OnlinePayment {...props} />);
  await waitFor(() => expect(screen.queryByLabelText("Card")).toBeNull());
  expect(screen.getByRole("alert").textContent).toContain("court hold has been released");
  expect(props.onConfirmed).not.toHaveBeenCalled();
});
