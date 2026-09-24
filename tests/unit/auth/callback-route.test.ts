import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const { exchangeCodeForSession, getUser, signOut } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession, getUser, signOut } }),
}));

import { GET } from "../../../src/app/auth/callback/route";

beforeEach(() => {
  vi.clearAllMocks();
});

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
  expect(new URL(response.headers.get("location")!).searchParams.get("notice")).toBe(
    "invalid-auth-link",
  );
  expect(new URL(response.headers.get("location")!).searchParams.has("error")).toBe(false);
});

it("maps a provider error to an application notice without displaying its text", async () => {
  signOut.mockResolvedValue({ error: null });
  const response = await GET(new NextRequest(
    "http://localhost:3000/auth/callback?error=Payment+confirmed&error_code=invalid_grant",
  ));

  const location = new URL(response.headers.get("location")!);
  expect(location.searchParams.get("notice")).toBe("invalid-auth-link");
  expect(location.searchParams.has("error")).toBe(false);
  expect(location.href).not.toContain("Payment");
});

it("maps a confirmed signup requiring sign-in to an application notice", async () => {
  exchangeCodeForSession.mockResolvedValue({ error: null });
  getUser.mockResolvedValue({ data: { user: null }, error: null });
  signOut.mockResolvedValue({ error: null });

  const response = await GET(new NextRequest(
    "http://localhost:3000/auth/callback?code=valid-code&next=/account&flow=email-confirmation",
  ));

  expect(new URL(response.headers.get("location")!).searchParams.get("notice")).toBe(
    "email-confirmed",
  );
});

it("does not treat a markerless account callback as email confirmation", async () => {
  exchangeCodeForSession.mockResolvedValue({ error: null });
  getUser.mockResolvedValue({ data: { user: null }, error: null });
  signOut.mockResolvedValue({ error: null });

  const response = await GET(new NextRequest(
    "http://localhost:3000/auth/callback?code=valid-code&next=/account",
  ));

  expect(new URL(response.headers.get("location")!).searchParams.get("notice")).toBe(
    "invalid-auth-link",
  );
});

it.each([
  ["without next", null, "/account"],
  ["with the password recovery destination", "/reset-password", "/reset-password"],
  ["with an arbitrary internal path", "/admin", "/account"],
  ["with an external URL", "https://attacker.example/path", "/account"],
  ["with a protocol-relative URL", "//attacker.example/path", "/account"],
  ["with a malformed path", "/\\attacker.example/path", "/account"],
] as const)("routes a verified callback %s", async (_case, next, expectedPath) => {
  exchangeCodeForSession.mockResolvedValue({ error: null });
  getUser.mockResolvedValue({ data: { user: { id: "member-1" } }, error: null });

  const url = new URL("http://localhost:3000/auth/callback?code=valid-code");
  if (next !== null) url.searchParams.set("next", next);
  const response = await GET(new NextRequest(url));

  expect(response.status).toBe(307);
  expect(new URL(response.headers.get("location")!).pathname).toBe(expectedPath);
});
