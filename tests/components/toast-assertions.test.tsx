// @vitest-environment jsdom
import { expectToast, lastToast } from "../helpers/notifications";
import { beforeAll, describe, expect, it } from "vitest";
import { toast } from "sonner";

const later = (emit: () => void) => setTimeout(emit, 20);

describe("a toast emitted before the test starts", () => {
  // Sonner's store is global: this toast stays active in it, as one left by an earlier test would.
  beforeAll(() => { toast.error("Unable to save court."); toast.success("Court saved."); });

  it("cannot satisfy an assertion for the operation under test", async () => {
    expect(toast.getToasts().map((item) => "title" in item && item.title)).toEqual(expect.arrayContaining(["Unable to save court.", "Court saved."]));
    await expect(expectToast("Unable to save court.")).rejects.toThrow();
    await expect(expectToast("Court saved.", "success")).rejects.toThrow();
    expect(lastToast()).toBe(""); expect(lastToast("success")).toBe("");
  });
});

it("starts without active toasts or recorded toast calls", () => {
  expect(toast.getToasts()).toEqual([]);
  expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
});

it("accepts a matching toast emitted asynchronously by the operation", async () => {
  later(() => toast.error("Unable to save court. Try again."));
  await expectToast("Unable to save court");
  expect(lastToast()).toBe("Unable to save court. Try again.");
});

it("accepts promise outcomes and same-id updates as new toasts", async () => {
  toast.promise(new Promise((resolve) => later(() => resolve(undefined))), { loading: "Saving…", success: "Saved." });
  expect(lastToast("loading")).toBe("Saving…");
  await expectToast("Saved.", "success");
  const id = toast.loading("Loading court availability");
  later(() => toast.error("Unable to load court availability.", { id }));
  await expectToast(/Unable to load/);
});

it("rejects a new toast with the wrong message or type", async () => {
  toast.error("Unable to archive location.");
  await expect(expectToast("Unable to save location")).rejects.toThrow();
  await expect(expectToast("Unable to archive location.", "success")).rejects.toThrow();
  await expectToast("Unable to archive location.");
});

it("requires each later operation to emit its own toast, even with the same message", async () => {
  toast.error("Unable to save location.");
  await expectToast("Unable to save location.");
  await expect(expectToast("Unable to save location.")).rejects.toThrow();
  later(() => toast.error("Unable to save location."));
  await expectToast("Unable to save location.");
});
