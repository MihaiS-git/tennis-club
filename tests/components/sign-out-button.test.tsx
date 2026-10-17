// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SignOutButton } from "@/components/sign-out-button";
import { ProfileDepartureForm } from "@/components/profile-departure-navigation";

afterEach(cleanup);

it("disables sign out during its form action and permits retry when the request returns", async () => {
  let finish!: () => void;
  const action = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<ProfileDepartureForm action={action}><SignOutButton className="text-primary" /></ProfileDepartureForm>);
  const button = screen.getByRole("button", { name: "Sign out" });
  expect(button).toHaveProperty("disabled", false);
  fireEvent.click(button);
  expect(screen.getByRole("button", { name: "Signing out…" })).toHaveProperty("disabled", true);
  fireEvent.click(button);
  expect(action).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(screen.getByRole("button", { name: "Sign out" })).toHaveProperty("disabled", false);
});
