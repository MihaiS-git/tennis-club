import "server-only";

import pino from "pino";

const sensitiveFields = [
  "password",
  "currentPassword",
  "confirmPassword",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "token",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "set-cookie",
  "Set-Cookie",
] as const;

const redactPaths = sensitiveFields.flatMap((field) => {
  const key = field.includes("-") ? `["${field}"]` : field;
  return [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`];
});

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  redact: { paths: redactPaths, censor: "[Redacted]" },
});
