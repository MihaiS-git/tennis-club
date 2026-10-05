import { readPlayerAvatar } from "@/lib/profile/avatar";

export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const result = await readPlayerAvatar(undefined, userId);
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (result.kind !== "image") {
    const status = { unauthenticated: 401, forbidden: 403, "not-found": 404, error: 503 }[result.kind];
    return new Response(null, { status, headers });
  }
  return new Response(result.file, { headers: { ...headers, "Content-Type": result.file.type } });
}
