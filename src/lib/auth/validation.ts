import { z } from "zod";

const email = z.string().trim().email("Enter a valid email address.");
const password = z
  .string()
  .min(6, "Password must be at least 6 characters long.");

export const signUpSchema = z
  .object({
    email,
    password,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password."),
});

export const recoverySchema = z.object({ email });

export const newPasswordSchema = z
  .object({
    password,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const changePasswordSchema = newPasswordSchema.safeExtend({
  currentPassword: z.string().min(1, "Enter your current password."),
}).refine((value) => value.password !== value.currentPassword, {
  message: "New password must be different from your current password.",
  path: ["password"],
});

export function fieldValidationErrors(
  error: z.ZodError,
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && errors[field] === undefined) {
      errors[field] = issue.message;
    }
  }

  return errors;
}
