import { expect, it } from "vitest";
import { tennisProfileSchema, profileFormInput } from "../../../src/lib/profile/validation";

const emptyTennis = Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""]));

it("does not extract client ownership, rating, or avatar paths", () => {
  const form = new FormData();
  form.set("display_name", "Ana"); form.set("rating", "2000"); form.set("user_id", "another"); form.set("avatar_path", "injected");
  expect(profileFormInput(form, Object.keys(tennisProfileSchema.shape))).toEqual({ ...emptyTennis, display_name: "Ana" });
});


it.each(["3", "10", "4.5", "advanced", 4])(
  "rejects invalid individual Sportya level %s", (level) => {
    expect(tennisProfileSchema.safeParse({ ...emptyTennis, sportya_level: level }).success).toBe(false);
  },
);
