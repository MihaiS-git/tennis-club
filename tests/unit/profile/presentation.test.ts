import { expect, it } from "vitest";
import { effectiveDisplayName, playerAvatarUrl } from "../../../src/lib/profile/presentation";
import { countries, countryCodes, countryFlag, isCountryCode } from "../../../src/lib/profile/countries";

it.each([
  [" Mihai ", " Suciu ", "Mihai Suciu"], ["Mihai", null, "Mihai"],
  [null, "Suciu", "Suciu"], [null, null, ""], ["  Mihai   Andrei ", " Suciu  ", "Mihai Andrei Suciu"],
])("derives a clean personal name from %s / %s", (first_name, last_name, expected) => {
  for (const displayName of [null, "", "  "]) {
    expect(effectiveDisplayName(displayName, { first_name, last_name })).toBe(expected);
  }
});
it("retains a chosen display name after personal-name changes", () => {
  expect(effectiveDisplayName(" Club   player ", { first_name: "Mihai", last_name: "Suciu" })).toBe("Club player");
  expect(effectiveDisplayName("Club player", { first_name: "New", last_name: "Name" })).toBe("Club player");
});
it("requests only the authenticated Next.js avatar route when a path exists", () => {
  expect(playerAvatarUrl(null)).toBeNull();
  expect(playerAvatarUrl({ avatar_path: null, updated_at: "now" })).toBeNull();
  expect(playerAvatarUrl({ avatar_path: "owner/avatar.png", updated_at: "2026-09-28T12:00:00Z" }))
    .toBe("/profile/avatar?v=2026-09-28T12%3A00%3A00Z");
});
it("owns all 249 distinct ISO alpha-2 codes and local English names", () => {
  expect(countryCodes).toHaveLength(249);
  expect(new Set(countryCodes).size).toBe(249);
  for (const { code, name } of countries) {
    expect(isCountryCode(code)).toBe(true);
    expect(name).not.toBe(code);
  }
  for (const [code, name] of [["RO", "Romania"], ["FR", "France"], ["GB", "United Kingdom"], ["US", "United States"]]) {
    expect(countries.find((country) => country.code === code)?.name).toBe(name);
  }
});

it.each([["RO", "🇷🇴"], ["FR", "🇫🇷"], ["GB", "🇬🇧"], ["DE", "🇩🇪"], ["IT", "🇮🇹"], ["ES", "🇪🇸"], ["US", "🇺🇸"]])(
  "derives the flag for %s from Unicode regional indicators", (code, flag) => {
    expect(countryFlag(code)).toBe(flag);
  },
);
it.each(["", "ZZ", "Romania"])("does not generate a flag for unsupported code %s", (code) => {
  expect(countryFlag(code)).toBe("");
});
