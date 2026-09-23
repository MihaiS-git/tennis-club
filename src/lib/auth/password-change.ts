type AuthError = { code?: string };

type PasswordVerificationResult = {
  data: { user: { id: string } | null };
  error: AuthError | null;
};

export type PasswordVerificationClient = {
  auth: {
    signInWithPassword(credentials: {
      email: string;
      password: string;
    }): Promise<PasswordVerificationResult>;
    signOut(options: { scope: "local" }): Promise<{ error: AuthError | null }>;
  };
};

export type PasswordUpdateClient = {
  auth: {
    updateUser(attributes: { password: string }): Promise<{
      error: AuthError | null;
    }>;
  };
};

export type PasswordChangeResult =
  | { ok: true }
  | { ok: false; reason: "current-password-incorrect" }
  | { ok: false; reason: "password-update-failed"; code?: string };

export async function changePasswordWithVerification(input: {
  authenticatedClient: PasswordUpdateClient;
  verificationClient: PasswordVerificationClient;
  userId: string;
  email: string;
  currentPassword: string;
  newPassword: string;
}): Promise<PasswordChangeResult> {
  const verification = await input.verificationClient.auth.signInWithPassword({
    email: input.email,
    password: input.currentPassword,
  });

  if (verification.error || verification.data.user?.id !== input.userId) {
    return { ok: false, reason: "current-password-incorrect" };
  }

  await input.verificationClient.auth.signOut({ scope: "local" });

  const { error } = await input.authenticatedClient.auth.updateUser({
    password: input.newPassword,
  });

  return error
    ? { ok: false, reason: "password-update-failed", code: error.code }
    : { ok: true };
}
