import { beforeEach, expect, it, vi } from "vitest";

const { signInWithPassword, getUser, redirect } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  getUser: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithPassword, getUser } }),
}));

import { signInAction } from "../../../src/app/(auth)/actions";

beforeEach(() => {
  vi.clearAllMocks();
  signInWithPassword.mockResolvedValue({ error: null });
  getUser.mockResolvedValue({ data: { user: { id: "member-1" } }, error: null });
});

it("redirects a successful normal sign-in to / even if next is submitted", async () => {
  const form = new FormData();
  form.set("email", "member@example.com");
  form.set("password", "safe-password-123");
  form.set("next", "/account");

  await expect(signInAction({}, form)).rejects.toThrow("redirect:/");
  expect(signInWithPassword).toHaveBeenCalledExactlyOnceWith({
    email: "member@example.com",
    password: "safe-password-123",
  });
  expect(getUser).toHaveBeenCalledOnce();
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/");
});
