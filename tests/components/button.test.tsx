// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "@/components/button";

afterEach(cleanup);

it("renders text actions without the standard button box or dimensions", () => {
  render(<Button variant="text" size="small" className="underline">Retry</Button>);
  const classes = screen.getByRole("button", { name: "Retry" }).className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(["text-primary", "underline", "focus-visible:outline-focus", "disabled:opacity-60"]));
  for (const boxClass of ["border", "inline-flex", "font-semibold", "min-h-9", "px-3", "w-full"]) expect(classes).not.toContain(boxClass);
});

it("keeps the shared box and size for standard variants", () => {
  render(<Button variant="secondary" size="small">Save</Button>);
  const classes = screen.getByRole("button", { name: "Save" }).className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(["inline-flex", "rounded-control", "border", "font-semibold", "min-h-9", "px-3"]));
});
