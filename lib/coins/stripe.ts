import "server-only";
import Stripe from "stripe";
import { cleanEnv } from "@/lib/env-clean";
import { CoinError } from "./ledger";

/** The one Stripe client, made on first use so a missing key fails the payment, not the whole app. */
let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(cleanEnv(process.env.STRIPE_SECRET_KEY));
}

export function getStripe(): Stripe {
  const key = cleanEnv(process.env.STRIPE_SECRET_KEY);
  if (!key) throw new CoinError("not_configured", "Payments aren't set up yet.");
  client ??= new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: "Ziki" } });
  return client;
}

export function webhookSecret(): string {
  const secret = cleanEnv(process.env.STRIPE_WEBHOOK_SECRET);
  if (!secret) throw new CoinError("not_configured", "STRIPE_WEBHOOK_SECRET is not set.");
  return secret;
}
