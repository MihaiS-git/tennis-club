import type { AuthErrorCode } from "./messages";

export type AuthActionState = {
  attempt: number;
  error?: AuthErrorCode;
};

export const initialAuthActionState: AuthActionState = {
  attempt: 0,
};

export function createAuthErrorState(
  previousState: AuthActionState,
  error: AuthErrorCode,
): AuthActionState {
  return {
    attempt: previousState.attempt + 1,
    error,
  };
}
