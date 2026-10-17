// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/button";

afterEach(cleanup);

it.each(["primary", "secondary", "destructive", "subtle"] as const)("keeps %s disabled actions inert and gates hover styling on enabled state", (variant) => {
  const click = vi.fn();
  const { rerender } = render(<Button variant={variant} disabled onClick={click}>Action</Button>);
  const button = screen.getByRole("button", { name: "Action" });
  expect(button).toHaveProperty("disabled", true);
  expect(button.className).toContain("disabled:opacity-60");
  const hoverClasses = button.className.split(" ").filter(token => token.includes("hover:"));
  expect(hoverClasses.length).toBeGreaterThan(0);
  expect(hoverClasses.every(token => token.startsWith("enabled:hover:"))).toBe(true);
  fireEvent.click(button);
  expect(click).not.toHaveBeenCalled();
  rerender(<Button variant={variant} onClick={click}>Action</Button>);
  fireEvent.click(button);
  expect(click).toHaveBeenCalledOnce();
});
