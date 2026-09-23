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
  let verification: PasswordVerificationResult;

  try {
    verification = await input.verificationClient.auth.signInWithPassword({
      email: input.email,
      password: input.currentPassword,
    });
  } catch {
    return { ok: false, reason: "current-password-incorrect" };
  }

  if (verification.error || verification.data.user?.id !== input.userId) {
    return { ok: false, reason: "current-password-incorrect" };
  }

  try {
    // This is an isolated, non-persisting session. Clearing it cannot alter the
    // cookie-backed application session used by authenticatedClient.
    await input.verificationClient.auth.signOut({ scope: "local" });
  } catch {
    // The isolated client has no persistent storage; update authorization still
    // comes exclusively from the application's existing authenticated session.
  }

  try {
    const { error } = await input.authenticatedClient.auth.updateUser({
      password: input.newPassword,
    });

    if (error) {
      return { ok: false, reason: "password-update-failed", code: error.code };
    }
  } catch {
    return { ok: false, reason: "password-update-failed" };
  }

  return { ok: true };
}
