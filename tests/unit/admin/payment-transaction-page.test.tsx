import { expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn(), notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/payments/admin", () => ({ listAdminPaymentTransactions: mocks.list }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/app/admin/payments/transaction-row", () => ({ TransactionRow: () => null }));
import TransactionPage from "@/app/admin/payments/transactions/[kind]/[transactionId]/page";
const id = "11111111-1111-4111-8111-111111111111";

test("details use the actual kind and ID, independent of list filters and page", async () => {
  mocks.authorize.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({ rows: [{ transaction_id: id, transaction_kind: "refund" }] });
  const page = await TransactionPage({ params: Promise.resolve({ kind: "refund", transactionId: id }),
    searchParams: Promise.resolve({ status: "failed", q: "another customer", page: "5" }) });
  expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: "all", q: "", page: 1 }), undefined, undefined,
    { kind: "refund", id });
  expect(page.props.listHref).toContain("page=5");
});

test("missing or invalid transaction identities produce not found", async () => {
  mocks.authorize.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({ rows: [] });
  for (const kind of ["refund", "invalid"]) await expect(TransactionPage({
    params: Promise.resolve({ kind, transactionId: id }), searchParams: Promise.resolve({}),
  })).rejects.toThrow("not found");
});

test("server authorization runs before any transaction read", async () => {
  mocks.list.mockClear();
  mocks.authorize.mockRejectedValueOnce(new Error("forbidden"));
  await expect(TransactionPage({ params: Promise.resolve({ kind: "payment", transactionId: id }), searchParams: Promise.resolve({}) })).rejects.toThrow("forbidden");
  expect(mocks.list).not.toHaveBeenCalled();
});
