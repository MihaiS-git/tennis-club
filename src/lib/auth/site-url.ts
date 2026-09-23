export function getApplicationUrl(path: string): string {
  const configuredUrl = process.env.APP_URL ?? "http://127.0.0.1:3000";
  const origin = new URL(configuredUrl);

  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("APP_URL must use http or https.");
  }

  const destination = new URL(path, origin);

  if (destination.origin !== origin.origin) {
    throw new Error("Application redirects must stay on APP_URL.");
  }

  return destination.toString();
}
