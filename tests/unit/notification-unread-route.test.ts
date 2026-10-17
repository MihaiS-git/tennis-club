import { beforeEach, expect, test, vi } from "vitest";
const { unread } = vi.hoisted(() => ({ unread: vi.fn() }));
vi.mock("@/lib/notifications/financial-notices", () => ({ readOwnUnreadNotifications: unread }));
import { GET } from "@/app/api/notifications/unread/route";
beforeEach(() => vi.resetAllMocks());
test("unread endpoint returns only the boolean with private no-store caching", async () => {
  unread.mockResolvedValue(true);
  const response = await GET();
  expect(await response.json()).toEqual({ unread: true });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
test("unread endpoint hides internal errors", async () => {
  unread.mockRejectedValue(new Error("private provider failure"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ message: "Unable to check notifications." });
});

test("each unread request reads current state rather than reusing an earlier result", async () => {
  unread.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await (await GET()).json()).toEqual({ unread: false });
  expect(await (await GET()).json()).toEqual({ unread: true });
  expect(unread).toHaveBeenCalledTimes(2);
});
