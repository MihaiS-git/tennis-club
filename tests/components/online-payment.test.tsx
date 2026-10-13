// @vitest-environment jsdom
import { lastToast } from "../helpers/notifications";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";

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
vi.mock("@/app/book/checkout-status", () => ({ readCheckoutStatus: status }));
import { OnlinePayment } from "@/app/book/online-payment";

const props = { checkout: { attemptId: "c9000000-0000-4000-8000-000000000011", token: "a".repeat(64),
  presentation: { kind: "stripe" as const, publishableKey: "pk_test_Fixture", clientSecret: "pi_fixture_secret" } },
  holdExpiresAt: "2099-10-15T10:00:00Z", onConfirmed: vi.fn() };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

test("a declined card leaves the same payment element available for another attempt", async () => {
  status.mockResolvedValue({ ok: true, status: "pending_payment", paymentStatus: "pending" });
  pay.mockResolvedValueOnce({ error: { type: "card_error", message: "Your card was declined." } }).mockResolvedValueOnce({});
  render(<OnlinePayment {...props} />);
  const card = screen.getByLabelText("Card");
  fireEvent.change(card, { target: { value: "declined card" } });
  fireEvent.submit(screen.getByRole("form", { name: "Online payment" }));
  await waitFor(() => expect(lastToast()).toBe("Your card was declined."));
  expect(screen.getByLabelText("Card")).toBe(card);
  expect((screen.getByRole("button", { name: "Pay and confirm booking" }) as HTMLButtonElement).disabled).toBe(false);
  expect(props.onConfirmed).not.toHaveBeenCalled();
  fireEvent.change(card, { target: { value: "another card" } });
  fireEvent.submit(screen.getByRole("form", { name: "Online payment" }));
  await waitFor(() => expect(pay).toHaveBeenCalledTimes(2));
  expect(pay.mock.calls.map(call => call[0].elements)).toEqual([elements, elements]);
  expect(status.mock.calls.every(call => call[0].attemptId === props.checkout.attemptId)).toBe(true);
});

test.each(["expired"])("a terminal %s checkout stops accepting cards without confirming a booking", async terminal => {
  status.mockResolvedValue({ ok: true, status: terminal, paymentStatus: terminal === "confirmed" ? "succeeded" : "expired" });
  render(<OnlinePayment {...props} />);
  await waitFor(() => expect(screen.queryByLabelText("Card")).toBeNull());
  expect(screen.getByRole("status").textContent).toContain("Payment cannot be started here");
  expect(props.onConfirmed).not.toHaveBeenCalled();
});

test.each(["confirmed", "expired"])("a late Stripe failure cannot overwrite the server's %s outcome", async terminal => {
  let finishStatus!: (result: unknown) => void;
  let failPayment!: (error: Error) => void;
  status.mockReturnValueOnce(new Promise((resolve) => { finishStatus = resolve; }));
  pay.mockReturnValueOnce(new Promise((resolve, reject) => {
    failPayment = terminal === "confirmed" ? reject : () => resolve({ error: { message: "Late provider failure" } });
  }));
  render(<OnlinePayment {...props} />);
  fireEvent.submit(screen.getByRole("form", { name: "Online payment" }));
  await waitFor(() => expect(pay).toHaveBeenCalledOnce());
  const notificationId = vi.mocked(toast.loading).mock.results.at(-1)?.value;
  await act(async () => finishStatus({ ok: true, status: terminal, paymentStatus: terminal === "confirmed" ? "succeeded" : "expired", totalAmountMinor: 1200, currency: "EUR", cancellationPolicy: null }));
  const terminalMessage = terminal === "confirmed" ? lastToast("success") : screen.getByRole("status").textContent;
  await act(async () => failPayment(new Error("Late provider failure")));
  expect(toast.warning).not.toHaveBeenCalled();
  expect(toast.getToasts().filter((item) => item.id === notificationId)).toHaveLength(1);
  expect(terminal === "confirmed" ? lastToast("success") : screen.getByRole("status").textContent).toBe(terminalMessage);
  expect(toast.getToasts().some((item) => "type" in item && item.type === "loading")).toBe(false);
});


test.each(["timeout", "expiration"])("%s stops payment even with an unavailable server and ignores late Stripe responses", async reason => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  pay.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  status.mockReturnValue(new Promise(() => {}));
  render(<OnlinePayment {...props} holdExpiresAt={new Date(Date.now() + (reason === "expiration" ? 1000 : 600_000)).toISOString()} />);
  fireEvent.submit(screen.getByRole("form", { name: "Online payment" }));
  expect(pay).toHaveBeenCalledOnce();
  const signal: unknown = status.mock.calls[0][1];
  if (!(signal instanceof AbortSignal)) throw new Error("Polling must support aborting independently of Server Actions");
  await act(async () => { await vi.advanceTimersByTimeAsync(reason === "expiration" ? 1001 : 31_000); });
  expect(screen.queryByLabelText("Card")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("do not pay again yet");
  expect(toast.getToasts().some(item => "type" in item && item.type === "loading")).toBe(false);
  await act(async () => { finish({ error: { type: "card_error", message: "Late decline" } }); });
  expect(toast.error).not.toHaveBeenCalled();
  fireEvent.submit(screen.getByRole("form", { name: "Online payment" }));
  expect(pay).toHaveBeenCalledOnce();
  expect(props.onConfirmed).not.toHaveBeenCalled();
  cleanup();
  expect(signal.aborted).toBe(true);
});
