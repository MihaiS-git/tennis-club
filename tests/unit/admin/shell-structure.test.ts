import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const adminRoot = resolve(process.cwd(), "src/app/admin");
const pages = ["page.tsx", "locations/page.tsx", "courts/page.tsx", "pricing/page.tsx", "users/page.tsx"];
const loadingFiles = ["loading.tsx", "locations/loading.tsx", "courts/loading.tsx", "pricing/loading.tsx", "users/loading.tsx"];

it("keeps navigation in the shared layout rather than individual pages", () => {
  expect(readFileSync(resolve(adminRoot, "layout.tsx"), "utf8")).toContain("<AdminNavigation />");
  for (const page of pages) {
    expect(readFileSync(resolve(adminRoot, page), "utf8")).not.toContain("AdminNavigation");
  }
});

it("has no route-level full-admin loading replacements", () => {
  for (const file of loadingFiles) expect(existsSync(resolve(adminRoot, file))).toBe(false);
});
