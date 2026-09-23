export function getApplicationUrl(path: string): string {
  const configuredUrl = process.env.APP_URL;

  if (!configuredUrl && process.env.NODE_ENV === "production") {
    throw new Error("APP_URL is required in production.");
  }

  const applicationUrl = configuredUrl ?? "http://localhost:3000";
  const origin = new URL(applicationUrl);

  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("APP_URL must use http or https.");
  }

  const destination = new URL(path, origin);

  if (destination.origin !== origin.origin) {
    throw new Error("Application redirects must stay on APP_URL.");
  }

  return destination.toString();
}
