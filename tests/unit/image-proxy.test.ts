import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/proxy", () => ({ updateSession: vi.fn() }));
import { config } from "@/proxy";

it("serves static AVIF and WebP without session refresh, preserving private avatar and page boundaries", () => {
  for (const url of ["/images/courts/tennis-courts-public-narrow-627.avif", "/images/home/tennis-hero-mobile-768.webp"]) {
    expect(doesProxyMatch({ config, url })).toBe(false);
  }
  for (const url of ["/profile/avatar", "/admin/users/111/avatar?v=123", "/profile", "/login", "/courts"]) {
    expect(doesProxyMatch({ config, url })).toBe(true);
  }
});
