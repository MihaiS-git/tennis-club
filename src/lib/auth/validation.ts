import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .email("Enter a valid email address.")
  .max(254, "Enter a valid email address.");

const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

const signUpSchema = z
  .object({
    email: emailSchema,
    password: z
      .string()
      .min(8, "Use at least 8 characters for your password.")
      .max(72, "Use no more than 72 characters for your password."),
    confirmPassword: z.string(),
  })
  .refine(({ confirmPassword, password }) => password === confirmPassword, {
    message: "The passwords do not match.",
    path: ["confirmPassword"],
  });

function getAuthFormFields(formData: FormData) {
  return {
    email: formData.get("email"),
    password: formData.get("password"),
  };
}

export function parseSignInForm(formData: FormData) {
  return signInSchema.safeParse(getAuthFormFields(formData));
}

export function parseSignUpForm(formData: FormData) {
  return signUpSchema.safeParse({
    ...getAuthFormFields(formData),
    confirmPassword: formData.get("confirmPassword"),
  });
}
