import { expect, it, vi } from "vitest";
const { readPlayerAvatar } = vi.hoisted(() => ({ readPlayerAvatar: vi.fn() }));
vi.mock("../../../src/lib/profile/avatar", () => ({ readPlayerAvatar }));
import { GET } from "../../../src/app/profile/avatar/route";

it.each([["unauthenticated", 401], ["forbidden", 403], ["not-found", 404], ["error", 503]])(
  "returns safe %s image responses", async (kind, status) => {
    readPlayerAvatar.mockResolvedValue({ kind }); const response = await GET();
    expect(response.status).toBe(status); expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  },
);
it("serves image bytes through Next.js with private no-store headers", async () => {
  readPlayerAvatar.mockResolvedValue({ kind: "image", file: new Blob(["image bytes"], { type: "image/png" }) });
  const response = await GET(); expect(response.status).toBe(200); expect(await response.text()).toBe("image bytes");
  expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
