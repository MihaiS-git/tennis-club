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

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    password: z.string().min(8).max(72),
    confirmPassword: z.string(),
  })
  .refine(({ confirmPassword, password }) => password === confirmPassword, {
    path: ["confirmPassword"],
  })
  .refine(({ currentPassword, password }) => currentPassword !== password, {
    path: ["password"],
  });

function getAuthFormFields(formData: FormData) {
  return {
    email: formData.get("email"),
    password: formData.get("password"),
  };
}

export function parsePasswordResetForm(formData: FormData) {
  return z.object({ email: emailSchema }).safeParse({
    email: formData.get("email"),
  });
}

export function parseNewPasswordForm(formData: FormData) {
  return signUpSchema
    .pick({ password: true, confirmPassword: true })
    .safeParse({
      password: formData.get("password"),
      confirmPassword: formData.get("confirmPassword"),
    });
}

export function parseChangePasswordForm(formData: FormData) {
  return changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
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
