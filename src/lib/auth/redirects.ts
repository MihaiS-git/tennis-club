const INTERNAL_ORIGIN = "https://tennis-club.invalid";

export function safeRedirectPath(
  value: string | null | undefined,
  fallback = "/account",
): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return fallback;

  try {
    const destination = new URL(value, INTERNAL_ORIGIN);

    if (destination.origin !== INTERNAL_ORIGIN) return fallback;

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}

export function loginPath(next: string): string {
  return `/login?${new URLSearchParams({ next: safeRedirectPath(next) }).toString()}`;
}

