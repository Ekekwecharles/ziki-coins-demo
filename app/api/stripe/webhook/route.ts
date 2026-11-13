import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { CoinError } from "@/lib/coins/ledger";
import { recordPurchase } from "@/lib/coins/purchase";
import { getStripe, webhookSecret } from "@/lib/coins/stripe";
import { failWithdrawal, markWithdrawalPaid, recordAccountUpdate } from "@/lib/coins/withdraw";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Stripe's webhook (#ziki-coins). It has no session; the signature is the
 * authentication, checked against the raw body before anything is read.
 *
 * Events it acts on (add exactly these to the endpoint in Stripe):
 * - `checkout.session.completed`: a pack was paid, credit the wallet once.
 * - `transfer.created`: a withdrawal's money is on its way, mark it paid.
 * - `transfer.reversed`: Stripe took a transfer back, return the Ziks.
 * - `account.updated`: a connected account's payout status changed.
 *
 * Everything it does is idempotent, so Stripe's retries and duplicate
 * deliveries change nothing. Answering 2xx for an event it doesn't handle
 * stops Stripe retrying it; a 5xx makes Stripe retry later.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing_signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    const body = await request.text();
    event = getStripe().webhooks.constructEvent(body, signature, webhookSecret());
  } catch (error) {
    if (error instanceof CoinError) return NextResponse.json({ error: "not_configured" }, { status: 503 });
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const outcome = await recordPurchase(event.data.object);
        return NextResponse.json({ received: true, outcome });
      }
      case "transfer.created": {
        const transfer = event.data.object;
        const withdrawalId = transfer.metadata?.withdrawalId;
        if (withdrawalId) await markWithdrawalPaid(withdrawalId, transfer.id);
        return NextResponse.json({ received: true });
      }
      case "transfer.reversed": {
        const transfer = event.data.object;
        const withdrawalId = transfer.metadata?.withdrawalId;
        if (withdrawalId) await failWithdrawal(withdrawalId, "Stripe reversed the transfer.");
        return NextResponse.json({ received: true });
      }
      case "account.updated": {
        await recordAccountUpdate(event.data.object);
        return NextResponse.json({ received: true });
      }
      default:
        return NextResponse.json({ received: true, ignored: true });
    }
  } catch (error) {
    console.error("[stripe-webhook]", event.type, error);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}
