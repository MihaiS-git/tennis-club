// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SubmitButton } from "@/components/submit-button";

afterEach(cleanup);

it("exposes busy state for the full form action without an extra live announcement", async () => {
  let finish!: () => void;
  const operation = new Promise<void>((resolve) => { finish = resolve; });
  render(<form action={async () => { await operation; }}>
    <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
  </form>);
  const button = screen.getByRole("button", { name: "Save" });
  expect(button.getAttribute("aria-busy")).toBe("false");
  fireEvent.click(button);
  expect(screen.getByRole("button", { name: "Saving…" })).toBe(button);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button).toHaveProperty("disabled", true);
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => { finish(); });
  expect(screen.getByRole("button", { name: "Save" })).toBe(button);
  expect(button.getAttribute("aria-busy")).toBe("false");
  expect(button).toHaveProperty("disabled", false);
});

it("distinguishes an externally disabled button from a submitting form", () => {
  render(<SubmitButton disabled pendingLabel="Saving…">Save</SubmitButton>);
  const button = screen.getByRole("button", { name: "Save" });
  expect(button).toHaveProperty("disabled", true);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("aria-busy")).toBe("false");
});
