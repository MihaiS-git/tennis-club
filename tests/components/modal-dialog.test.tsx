// @vitest-environment jsdom
import { StrictMode, act, useRef } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModalDialog } from "../../src/components/modal-dialog";

function TwoDialogs({ first, second }: { first: boolean; second: boolean }) {
  const firstRef = useRef<HTMLDialogElement>(null);
  const secondRef = useRef<HTMLDialogElement>(null);
  return <>
    <ModalDialog ref={firstRef} active={first} aria-label="First">First content</ModalDialog>
    <ModalDialog ref={secondRef} active={second} aria-label="Second">Second content</ModalDialog>
  </>;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  document.body.style.overflow = "auto";
  document.documentElement.style.overflow = "scroll";
});
afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
  document.documentElement.style.overflow = "";
});

it.each([false, true])("hydrates a ModalDialog with active=%s", async (active) => {
  const ref = { current: null as HTMLDialogElement | null };
  const element = <ModalDialog ref={ref} active={active} aria-label="Hydrated dialog">Content</ModalDialog>;
  const browserDocument = document;
  let html: string;
  vi.stubGlobal("document", undefined);
  try {
    html = renderToString(element);
  } finally {
    vi.stubGlobal("document", browserDocument);
  }
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const hydrationError = vi.spyOn(console, "error").mockImplementation(() => {});
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, element); });
    expect(hydrationError).not.toHaveBeenCalled();
    expect(ref.current?.open).toBe(active);
  } finally {
    await act(async () => { root?.unmount(); });
    hydrationError.mockRestore();
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("locks both document scrollers while a modal is open and restores their prior values", () => {
  document.documentElement.scrollTop = 160;
  const view = render(<TwoDialogs first second={false} />);
  const dialog = screen.getByRole("dialog", { name: "First" });
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.documentElement.style.overflow).toBe("hidden");
  expect(getComputedStyle(dialog).overflowY).toBe("auto");
  expect(getComputedStyle(dialog).maxHeight).toContain("100dvh");

  view.rerender(<TwoDialogs first={false} second={false} />);
  expect(document.body.style.overflow).toBe("auto");
  expect(document.documentElement.style.overflow).toBe("scroll");
  expect(document.documentElement.scrollTop).toBe(160);
});

it("keeps the lock until the last modal closes and releases it on unmount", () => {
  const view = render(<TwoDialogs first second />);
  view.rerender(<TwoDialogs first={false} second />);
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.documentElement.style.overflow).toBe("hidden");
  view.unmount();
  expect(document.body.style.overflow).toBe("auto");
  expect(document.documentElement.style.overflow).toBe("scroll");
});

it("does not close active dialogs during development effect replay", () => {
  const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  const close = vi.fn(function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event("close")); });
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = close;
  const onClose = vi.fn();
  const ref = { current: null as HTMLDialogElement | null };
  const view = render(<StrictMode><ModalDialog ref={ref} active onClose={onClose}>Content</ModalDialog></StrictMode>);
  expect(showModal).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.body.style.overflow).toBe("hidden");

  view.rerender(<StrictMode><ModalDialog ref={ref} active={false} onClose={onClose}>Content</ModalDialog></StrictMode>);
  expect(close).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.body.style.overflow).toBe("auto");
});
