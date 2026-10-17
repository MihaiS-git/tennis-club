// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/app/profile/own-profile", () => ({ readOwnProfile: read }));
vi.mock("@/app/profile/profile-forms", () => ({ AvatarForms: () => <button>Edit photo</button> }));
import ProfilePage from "@/app/profile/page";

afterEach(cleanup);

const player = { display_name: "Ana Popescu", avatar_path: null, rating: 1250, sportya_level: "6",
  handedness: "right", backhand: "two_handed", preferred_game: "singles", preferred_surface: "clay" };

it("preserves player information and the complete multiline biography", async () => {
  const bio = `I play at weekends.\n\n${"A long biography ".repeat(100)}\n${"x".repeat(300)}`;
  read.mockResolvedValue({ profile: { personal: {}, player: { ...player, bio } } });
  render(await ProfilePage());
  expect(screen.getByRole("heading", { name: player.display_name })).toBeTruthy();
  expect(screen.getByText("1250")).toBeTruthy();
  expect(screen.getByText("Level 6")).toBeTruthy();
  const style = screen.getByRole("region", { name: "Playing style" });
  expect(within(style).getAllByRole("definition").map((item) => item.textContent))
    .toEqual(["Right-handed", "Two-handed", "Singles", "Clay"]);
  const about = screen.getByRole("region", { name: "About me" });
  expect(about.querySelector("p")?.textContent).toBe(bio);
});

it.each([null, "", "   "])("handles an empty biography (%s)", async (bio) => {
  read.mockResolvedValue({ profile: { personal: {}, player: { ...player, bio } } });
  render(await ProfilePage());
  expect(within(screen.getByRole("region", { name: "About me" })).getByText("You haven’t added a biography yet.")).toBeTruthy();
});
