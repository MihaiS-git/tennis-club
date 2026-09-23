import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";

const { exchangeCodeForSession, getUser, signOut } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession, getUser, signOut } }),
}));

import { GET } from "../../../src/app/auth/callback/route";

it("rejects an invalid confirmation code without claiming the email was confirmed", async () => {
  exchangeCodeForSession.mockResolvedValue({ error: { code: "invalid_grant" } });
  signOut.mockResolvedValue({ error: null });

  const response = await GET(
    new NextRequest(
      "http://localhost:3000/auth/callback?code=invalid-code&next=/account&flow=email-confirmation",
    ),
  );

  expect(response.status).toBe(307);
  expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe(
    "This authentication link is invalid or has expired.",
  );
  expect(new URL(response.headers.get("location")!).searchParams.has("message")).toBe(false);
  expect(getUser).not.toHaveBeenCalled();
  expect(signOut).toHaveBeenCalledWith({ scope: "local" });
});
