// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import NotFound from "../../src/app/not-found";

afterEach(cleanup);

it("shows the branded 404 content", () => {
  render(<NotFound />);

  expect(screen.getByRole("heading", { level: 1, name: "404" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 2, name: "This page is out of bounds." })).toBeTruthy();
  expect(screen.getByText("The page you're looking for doesn't exist or may have moved.")).toBeTruthy();
});

it("links back to home", () => {
  render(<NotFound />);

  expect(screen.getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("/");
});

it("links to court booking", () => {
  render(<NotFound />);

  expect(screen.getByRole("link", { name: "Book a court" }).getAttribute("href")).toBe("/book");
});
