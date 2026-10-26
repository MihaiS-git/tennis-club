import { expect, test } from "vitest";
import { generateSlug } from "@/lib/admin/slug";

test("slugs strip diacritics and join lowercase ASCII words with single hyphens", () => {
  expect(generateSlug("Bază Sportivă Ștefan cel Mare")).toBe("baza-sportiva-stefan-cel-mare");
  expect(generateSlug("  Court #1 — Centre!  ")).toBe("court-1-centre");
  expect(generateSlug("Ｃｏｕｒｔ ２")).toBe("court-2");
  expect(generateSlug("Łódź")).toBe("odz");
  expect(generateSlug("!!!")).toBe("");
});
