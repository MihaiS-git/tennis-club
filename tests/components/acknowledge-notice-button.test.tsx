// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { refresh, acknowledge, toastError } = vi.hoisted(() => ({ refresh: vi.fn(), acknowledge: vi.fn(), toastError: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("@/app/my-activity/actions", () => ({ acknowledgeFinancialNoticeAction: acknowledge }));
import { AcknowledgeNoticeButton } from "@/app/my-activity/acknowledge-notice-button";

const id = "c9000000-0000-4000-8000-000000000031";
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("OK persists acknowledgement for this notice and refreshes the page", async () => {
  acknowledge.mockResolvedValue({ ok: true });
  render(<AcknowledgeNoticeButton id={id} />);
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(acknowledge).toHaveBeenCalledWith(id);
  expect(toastError).not.toHaveBeenCalled();
});

test("a failed acknowledgement keeps the notice and explains the failure", async () => {
  acknowledge.mockResolvedValue({ ok: false, message: "Unable to save. Try again." });
  render(<AcknowledgeNoticeButton id={id} />);
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("Unable to save. Try again."));
});
