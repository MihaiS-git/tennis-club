import { z } from "zod";

const optionalText = (limit: number) => z.string().trim().max(limit, `Use at most ${limit} characters.`)
  .transform((value) => value || null);
const choice = <T extends string>(values: readonly [T, ...T[]]) =>
  z.union([z.enum(values), z.literal("")]).transform((value) => value || null);

// Kept separate until the controlled Sportya values are established.
export const sportyaLevelSchema = optionalText(80);

export const personalInformationSchema = z.strictObject({
  first_name: optionalText(100),
  last_name: optionalText(100),
  phone: optionalText(40),
  date_of_birth: z.union([z.iso.date("Enter a valid date."), z.literal("")]).transform((value) => value || null),
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(100),
  postal_code: optionalText(20),
  country_code: z.string().trim().toUpperCase().refine((value) => value === "" || /^[A-Z]{2}$/.test(value),
    "Enter a two-letter country code.").transform((value) => value || null),
});

export const tennisProfileSchema = z.strictObject({
  display_name: optionalText(100),
  sportya_level: sportyaLevelSchema,
  handedness: choice(["right", "left"]),
  backhand: choice(["one_handed", "two_handed"]),
  preferred_game: choice(["singles", "doubles", "both"]),
  preferred_surface: choice(["clay", "hard", "grass", "carpet", "any"]),
  bio: optionalText(2000),
});

export type PersonalInformation = z.output<typeof personalInformationSchema>;
export type TennisProfile = z.output<typeof tennisProfileSchema>;
export type ProfileActionState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: string;
};

export function profileFormInput(formData: FormData, fields: readonly string[]) {
  return Object.fromEntries(fields.map((field) => {
    const value = formData.get(field);
    return [field, typeof value === "string" ? value : ""];
  }));
}
