import "server-only";

import { timingSafeEqual } from "node:crypto";

export function authorizedBearer(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || secret.trim() !== secret || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
