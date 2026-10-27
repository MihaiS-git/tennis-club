// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogMock } from "../helpers/dialog";
import { LoadingStatus } from "@/components/loading-status";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { CoachingDeleteButton } from "@/app/admin/coaching/delete-button";

const mocks = vi.hoisted(() => ({ deleteProgram: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/admin/coaching/actions", () => ({ deleteCoachingProgramAction: mocks.deleteProgram,
  deleteCoachProfileAction: vi.fn(), setCoachingProgramStatusAction: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => { vi.resetAllMocks(); installDialogMock(); });
afterEach(cleanup);

it.each(["inline", "section", "page"] as const)("announces %s loading with a reduced-motion-safe spinner", (variant) => {
  render(<LoadingStatus variant={variant} label="Loading court availability…" />);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Loading court availability…");
  expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(status.querySelector("svg")?.getAttribute("class")).toContain("motion-safe:animate-spin");
  expect(status.className.includes("min-h-20")).toBe(variant === "section");
  expect(status.className.includes("min-h-60")).toBe(variant === "page");
});

it("shows the pending label while keeping controls disabled and Escape blocked", () => {
  const onConfirm = vi.fn();
  const props = { open: true, title: "Cancel booking?", message: "Free the court.", confirmLabel: "Cancel booking",
    pendingLabel: "Cancelling booking…", cancelLabel: "Keep booking", onConfirm, onClose: vi.fn() };
  const { rerender } = render(<ConfirmationDialog {...props} />);
  expect(screen.getByRole("button", { name: "Cancel booking" })).toBeTruthy();
  rerender(<ConfirmationDialog {...props} pending />);
  const dialog = screen.getByRole("dialog", { name: "Cancel booking?" });
  const confirm = within(dialog).getByRole("button", { name: "Cancelling booking…" });
  expect(confirm).toHaveProperty("disabled", true);
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect(within(dialog).getByRole("button", { name: "Keep booking" })).toHaveProperty("disabled", true);
  const escape = new Event("cancel", { cancelable: true });
  dialog.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  fireEvent.click(confirm);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("keeps the confirm label when no pending label is given", () => {
  render(<ConfirmationDialog open pending title="Remove?" message="" confirmLabel="Remove" onConfirm={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Remove" })).toHaveProperty("disabled", true);
});

it("labels a pending coaching deletion and submits it once", async () => {
  let finish!: (value: { ok: true }) => void;
  mocks.deleteProgram.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<CoachingDeleteButton kind="program" id="program-1" name="Private lesson" />);
  fireEvent.click(screen.getByRole("button", { name: "Delete program" }));
  const dialog = screen.getByRole("dialog", { name: "Delete Private lesson?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete program" }));
  const pending = await within(dialog).findByRole("button", { name: "Deleting program…" });
  fireEvent.click(pending);
  expect(mocks.deleteProgram).toHaveBeenCalledOnce();
  finish({ ok: true });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
