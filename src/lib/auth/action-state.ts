export type AuthFieldName =
  | "email"
  | "password"
  | "confirmPassword"
  | "currentPassword";

export type AuthActionState = {
  success?: string;
  fieldErrors?: Partial<Record<AuthFieldName, string>>;
  formError?: string;
};

export const initialAuthActionState: AuthActionState = {};
