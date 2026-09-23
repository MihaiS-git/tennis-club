// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const { location, replace, success, error } = vi.hoisted(() => ({
  location: { pathname: "/account", searchParams: new URLSearchParams() },
  replace: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ replace }),
  useSearchParams: () => location.searchParams,
}));
vi.mock("sonner", () => ({ toast: { success, error } }));

import { QueryFlashMessages } from "../../src/components/query-flash-messages";

beforeEach(() => {
  vi.clearAllMocks();
  location.pathname = "/account";
  location.searchParams = new URLSearchParams();
});
afterEach(cleanup);

it("shows each flash once, removes consumed params, and preserves unrelated URL state", async () => {
  location.searchParams = new URLSearchParams(
    "next=%2Fbooking%3Fcourt%3D2&filter=upcoming&page=3&message=Booking+confirmed&error=Payment+failed",
  );
  const view = render(<QueryFlashMessages />);

  await waitFor(() => {
    expect(success).toHaveBeenCalledExactlyOnceWith("Booking confirmed");
    expect(error).toHaveBeenCalledExactlyOnceWith("Payment failed");
    expect(replace).toHaveBeenCalledTimes(1);
  });

  const [destination, options] = replace.mock.calls[0];
  const cleaned = new URL(destination, "https://club.example");
  expect(cleaned.pathname).toBe("/account");
  expect(cleaned.searchParams.get("next")).toBe("/booking?court=2");
  expect(cleaned.searchParams.get("filter")).toBe("upcoming");
  expect(cleaned.searchParams.get("page")).toBe("3");
  expect(cleaned.searchParams.has("message")).toBe(false);
  expect(cleaned.searchParams.has("error")).toBe(false);
  expect(options).toEqual({ scroll: false });

  location.searchParams = new URLSearchParams(
    "next=%2Fbooking%3Fcourt%3D2&filter=upcoming&page=3&message=Booking+confirmed&error=Payment+failed",
  );
  view.rerender(<QueryFlashMessages />);
  expect(success).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledTimes(1);

  location.searchParams = cleaned.searchParams;
  view.rerender(<QueryFlashMessages />);
  expect(success).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledTimes(1);
});
