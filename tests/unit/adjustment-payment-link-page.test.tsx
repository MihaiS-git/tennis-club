import { beforeEach, expect, test, vi } from "vitest";
import { connection } from "next/server";
import { readAdjustmentPaymentLink } from "@/lib/payments/checkout";
import Page from "@/app/book/adjustments/[adjustmentId]/page";
import { AdjustmentPayment } from "@/app/book/adjustments/[adjustmentId]/payment";

vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@/lib/payments/checkout", () => ({ readAdjustmentPaymentLink: vi.fn() }));
vi.mock("@/app/book/adjustments/[adjustmentId]/payment", () => ({ AdjustmentPayment: () => null }));
beforeEach(() => vi.resetAllMocks());
const id = "db000000-0000-4000-8000-000000000001", token = "a".repeat(64);
const available = { kind: "checkout", originalTotal: 5000, newTotal: 7500, currency: "RON",
  checkout: { attemptId: "db000000-0000-4000-8000-000000000002", token,
    presentation: { kind: "stripe", clientSecret: "existing-secret", publishableKey: "pk_test_Fixture" } },
  holdExpiresAt: "2099-10-15T10:00:00Z" } as const;

async function content(searchParams = { token }) {
  const page = Page({ params: Promise.resolve({ adjustmentId: id }), searchParams: Promise.resolve(searchParams) });
  const child = page.props.children[1].props.children;
  return child.type(child.props);
}

test("the route delegates request input once and renders the returned checkout", async () => {
  vi.mocked(readAdjustmentPaymentLink).mockResolvedValue(available);
  const rendered = await content();
  expect(connection).toHaveBeenCalledOnce();
  expect(readAdjustmentPaymentLink).toHaveBeenCalledExactlyOnceWith({ adjustmentId: id, token });
  expect(rendered.type).toBe(AdjustmentPayment);
  expect(rendered.props).toEqual({ originalTotal: 5000, newTotal: 7500, currency: "RON", checkout: available.checkout,
    holdExpiresAt: available.holdExpiresAt });
});

test("unavailable links render only the safe response", async () => {
  vi.mocked(readAdjustmentPaymentLink).mockResolvedValue({ kind: "unavailable" });
  const rendered = await content();
  expect(rendered.type).toBe("p");
  expect(rendered.props.children).toBe("Payment link unavailable.");
});

test("query parameters cannot replace the route's adjustment identity", async () => {
  vi.mocked(readAdjustmentPaymentLink).mockResolvedValue({ kind: "unavailable" });
  const query = { token, adjustmentId: "other-adjustment" };
  await content(query);
  expect(readAdjustmentPaymentLink).toHaveBeenCalledExactlyOnceWith({ adjustmentId: id, token });
});
