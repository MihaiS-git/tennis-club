import { readOnlineCheckout } from "@/lib/payments/checkout";

export async function POST(request: Request) {
  try {
    const result = await readOnlineCheckout(await request.json());
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, message: "Unable to check payment." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
