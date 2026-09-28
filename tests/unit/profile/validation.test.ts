import { expect, it } from "vitest";
import { personalInformationSchema, tennisProfileSchema, profileFormInput } from "../../../src/lib/profile/validation";

const emptyPersonal = Object.fromEntries(Object.keys(personalInformationSchema.shape).map((key) => [key, ""]));
const emptyTennis = Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""]));

it("normalizes optional personal data and country codes", () => {
  expect(personalInformationSchema.parse({ ...emptyPersonal, first_name: " Ana ", country_code: " ro " })).toMatchObject({
    first_name: "Ana", country_code: "RO", date_of_birth: null, phone: null,
  });
});
it.each([{ date_of_birth: "2026-02-30" }, { country_code: "Romania" }, { phone: "x".repeat(41) }, { first_name: "x".repeat(101) }, { status: "active" }, { id: "victim" }, { email: "spoof@example.test" }, { created_at: "now" }])(
  "rejects invalid personal information %j", (input) => expect(personalInformationSchema.safeParse({ ...emptyPersonal, ...input }).success).toBe(false),
);
it("normalizes optional tennis choices", () => {
  expect(tennisProfileSchema.parse({ ...emptyTennis, sportya_level: "4", preferred_game: "both" }))
    .toMatchObject({ sportya_level: "4", preferred_game: "both", bio: null, handedness: null });
});
it.each([{ handedness: "ambidextrous" }, { preferred_surface: "ice" }, { bio: "x".repeat(2001) }, { rating: 2000 }, { user_id: "someone" }, { avatar_path: "someone/avatar.png" }])(
  "rejects invalid or managed tennis fields %j", (input) => expect(tennisProfileSchema.safeParse({ ...emptyTennis, ...input }).success).toBe(false),
);
it("does not extract client ownership, rating, or avatar paths", () => {
  const form = new FormData();
  form.set("display_name", "Ana"); form.set("rating", "2000"); form.set("user_id", "another"); form.set("avatar_path", "injected");
  expect(profileFormInput(form, Object.keys(tennisProfileSchema.shape))).toEqual({ ...emptyTennis, display_name: "Ana" });
});


it.each(["", null, "4", "5", "6", "7", "8", "9"])("accepts individual Sportya level %s", (level) => {
  expect(tennisProfileSchema.parse({ ...emptyTennis, sportya_level: level }).sportya_level).toBe(level || null);
});
it.each(["3", "10", "4.5", "5.5", "6.5", "7.5", "8.5", "beginner", "advanced", "anything", 4])(
  "rejects invalid individual Sportya level %s", (level) => {
    expect(tennisProfileSchema.safeParse({ ...emptyTennis, sportya_level: level }).success).toBe(false);
  },
);
it.each(["ZZ", "UK", "EU", "XK", "AA", "Romania", "R0"])("rejects noncanonical country %s", (country_code) => {
  expect(personalInformationSchema.safeParse({ ...emptyPersonal, country_code }).success).toBe(false);
});
it.each([
  ["handedness", ["right", "left"]], ["backhand", ["one_handed", "two_handed"]],
  ["preferred_game", ["singles", "doubles", "both"]], ["preferred_surface", ["clay", "hard", "grass", "carpet", "any"]],
])("preserves canonical %s values and rejects arbitrary values", (field, values) => {
  for (const value of ["", ...values]) {
    expect(tennisProfileSchema.parse({ ...emptyTennis, [field]: value })).toHaveProperty(field, value || null);
  }
  expect(tennisProfileSchema.safeParse({ ...emptyTennis, [field]: "invalid" }).success).toBe(false);
});
