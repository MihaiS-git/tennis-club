import { abandonOnlineCheckout } from "@/lib/payments/checkout";

// Best effort navigation cleanup. The same capability and lifecycle as explicit
// cancellation apply; submitted payments are left to polling/webhooks/expiry.
export async function POST(request: Request) {
  try {
    const result = await abandonOnlineCheckout(await request.json(), true);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ released: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
