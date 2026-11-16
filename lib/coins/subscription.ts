import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { absoluteUrl } from "@/lib/site-url";
import { CoinError, lockUser } from "./ledger";
import { DISCOUNT_SUBSCRIPTION_STATUSES, LIVE_SUBSCRIPTION_STATUSES, findPlan } from "./plans";
import { getStripe } from "./stripe";

/**
 * Ziki plans (#ziki-coins). An owner subscribes through Stripe Checkout and Stripe charges the monthly fee. While the
 * plan is paid up, the Ziks packs they buy are cheaper by the plan's discount (lib/coins/purchase.ts reads
 * `discountPercentFor`). The fee buys no Ziks, so a paid invoice only records the income (a CoinPurchase of zero
 * Ziks, which the money page's check against Stripe counts) and writes nothing to the ledger. The subscription row is
 * only a mirror of Stripe's (status, renewal date, whether it is set to end), refreshed from Stripe each time an event
 * names it, so an old event arriving late can't put it back.
 */

/** The person's plan that is still in force (paid up, or late and being retried), if they have one. */
export async function liveSubscriptionOf(userId: string) {
  return prisma.coinSubscription.findFirst({
    where: { userId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}

/** The discount on Ziks packs the person has right now: their plan's, while it is paid up; otherwise none. */
export async function discountPercentFor(userId: string): Promise<number> {
  const subscription = await prisma.coinSubscription.findFirst({
    where: { userId, status: { in: [...DISCOUNT_SUBSCRIPTION_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { planId: true },
  });
  return findPlan(subscription?.planId)?.discountPercent ?? 0;
}

/** The person's Stripe customer, made once so their card is reused for the next plan or a later payment. */
async function customerFor(userId: string, email: string | undefined): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { stripeCustomerId: true } });
  if (user.stripeCustomerId) return user.stripeCustomerId;
  // The same key for the same person: two clicks at once get the same customer back.
  const customer = await getStripe().customers.create({ email, metadata: { userId } }, { idempotencyKey: `ziki-customer-${userId}` });
  await prisma.user.updateMany({ where: { id: userId, stripeCustomerId: null }, data: { stripeCustomerId: customer.id } });
  const saved = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
  return saved?.stripeCustomerId ?? customer.id;
}

/** The pages a plan can be started from, so cancelling at Stripe lands back where the person was. */
export type SubscribeFrom = "coins" | "pricing";

export function subscribeFrom(value: unknown): SubscribeFrom {
  return value === "pricing" ? "pricing" : "coins";
}

/** Sends the person to Stripe Checkout to start a plan. The discount follows once Stripe confirms the first payment. */
export async function createSubscriptionCheckout(userId: string, email: string | undefined, planId: string, from: SubscribeFrom = "coins"): Promise<string> {
  const plan = findPlan(planId);
  if (!plan) throw new CoinError("invalid_amount", "Choose one of the plans.");
  if (await liveSubscriptionOf(userId)) {
    throw new CoinError("not_allowed", "You already have a monthly plan. End it first to choose a different one.");
  }
  const customer = await customerFor(userId, email);
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: userId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: plan.monthlyCents,
          recurring: { interval: "month" },
          product_data: { name: `Ziki ${plan.label}`, description: `${plan.discountPercent}% off every Ziks pack while you are subscribed` },
        },
      },
    ],
    // On the subscription, so every invoice it makes carries who it is for and which plan (invoice.parent.subscription_details.metadata).
    subscription_data: { metadata: { userId, planId: plan.id } },
    metadata: { userId, planId: plan.id },
    success_url: absoluteUrl("/coins?subscribed=1"),
    cancel_url: absoluteUrl(from === "pricing" ? "/pricing" : "/coins"),
  });
  if (!session.url) throw new CoinError("not_configured", "Stripe didn't return a checkout page.");
  return session.url;
}

/** Stripe's processing fee on an invoice's payment, in cents, when it can be read. Only for the money page's check. */
async function stripeFeeForInvoice(invoiceId: string): Promise<number | null> {
  try {
    const payments = await getStripe().invoicePayments.list({
      invoice: invoiceId,
      limit: 1,
      expand: ["data.payment.payment_intent.latest_charge.balance_transaction"],
    });
    const intent = payments.data[0]?.payment?.payment_intent;
    const charge = intent && typeof intent !== "string" ? intent.latest_charge : null;
    if (charge && typeof charge !== "string" && charge.balance_transaction && typeof charge.balance_transaction !== "string") {
      return charge.balance_transaction.fee;
    }
  } catch {
    // The credit doesn't wait on the fee.
  }
  return null;
}

/**
 * One paid invoice of a plan's monthly fee: recorded once as income (a purchase of zero Ziks, so the money page's check
 * against Stripe counts the cash), with nothing written to the Ziks ledger because the fee buys no Ziks. Only the plan's
 * two ordinary reasons count (the first invoice, and each monthly renewal), and only when the amount paid is the plan's
 * fee, so a free invoice, a changed price or a manual one is left alone.
 */
export async function recordSubscriptionPayment(invoice: Stripe.Invoice): Promise<"recorded" | "duplicate" | "ignored"> {
  if (invoice.status !== "paid") return "ignored";
  if (invoice.billing_reason !== "subscription_create" && invoice.billing_reason !== "subscription_cycle") return "ignored";
  const details = invoice.parent?.subscription_details;
  if (!details) return "ignored";
  const userId = details.metadata?.userId;
  const plan = findPlan(details.metadata?.planId);
  if (!userId || !plan || !invoice.id) return "ignored";
  if (invoice.amount_paid !== plan.monthlyCents) return "ignored";
  const subscriptionId = typeof details.subscription === "string" ? details.subscription : details.subscription.id;

  const feeCents = await stripeFeeForInvoice(invoice.id);
  // Make sure our row for the subscription exists before the purchase points at it (events can arrive in any order).
  await syncSubscriptionById(subscriptionId).catch(() => "ignored" as const);

  return prisma.$transaction(async (tx) => {
    if (!(await tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) return "ignored";
    await lockUser(tx, userId);
    if (await tx.coinPurchase.findUnique({ where: { stripeInvoiceId: invoice.id! }, select: { id: true } })) return "duplicate";
    const subscription = await tx.coinSubscription.findUnique({ where: { stripeSubscriptionId: subscriptionId }, select: { id: true } });
    await tx.coinPurchase.create({
      data: {
        userId,
        stripeInvoiceId: invoice.id!,
        planId: plan.id,
        subscriptionId: subscription?.id ?? null,
        zik: 0,
        amountCents: invoice.amount_paid,
        stripeFeeCents: feeCents,
        currency: invoice.currency ?? "usd",
      },
    });
    return "recorded";
  });
}

/** The renewal date: Stripe keeps it on the subscription's item, not on the subscription. */
function periodEndOf(subscription: Stripe.Subscription): Date | null {
  const end = subscription.items.data[0]?.current_period_end;
  return end ? new Date(end * 1000) : null;
}

/** Where a person can pay a failed invoice, for a plan that is late; null when there isn't one to pay. */
async function payUrlFor(subscription: Stripe.Subscription): Promise<string | null> {
  if (subscription.status !== "past_due" && subscription.status !== "unpaid" && subscription.status !== "incomplete") return null;
  const latest = subscription.latest_invoice;
  try {
    const invoice = typeof latest === "string" ? await getStripe().invoices.retrieve(latest) : latest;
    return invoice?.hosted_invoice_url ?? null;
  } catch {
    return null;
  }
}

/** Mirrors Stripe's subscription into ours: who it is for, which plan, its status, renewal date and whether it is ending. */
export async function applySubscription(subscription: Stripe.Subscription): Promise<"synced" | "ignored"> {
  const userId = subscription.metadata?.userId;
  const plan = findPlan(subscription.metadata?.planId);
  if (!userId || !plan) return "ignored";
  if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) return "ignored";
  const data = {
    status: subscription.status,
    currentPeriodEnd: periodEndOf(subscription),
    cancelAtPeriodEnd: subscription.cancel_at_period_end || Boolean(subscription.cancel_at),
    payUrl: await payUrlFor(subscription),
  };
  await prisma.coinSubscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    create: { userId, stripeSubscriptionId: subscription.id, planId: plan.id, ...data },
    update: data,
  });
  return "synced";
}

/** Reads the subscription from Stripe and mirrors it: the webhook's way, so a stale event can't win over the current state. */
export async function syncSubscriptionById(subscriptionId: string): Promise<"synced" | "ignored"> {
  return applySubscription(await getStripe().subscriptions.retrieve(subscriptionId));
}

/** For when the person comes back from Checkout: their plan shows at once rather than when the webhook gets there. */
export async function syncUserSubscriptions(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
  if (!user?.stripeCustomerId) return;
  const list = await getStripe().subscriptions.list({ customer: user.stripeCustomerId, status: "all", limit: 5 });
  for (const subscription of list.data) await applySubscription(subscription);
}

/** Ends the person's plan at the end of the month they have paid for. They keep what they paid for until then. */
export async function setSubscriptionEnding(userId: string, ending: boolean): Promise<void> {
  const subscription = await liveSubscriptionOf(userId);
  if (!subscription) throw new CoinError("not_found", "You don't have a monthly plan.");
  const updated = await getStripe().subscriptions.update(subscription.stripeSubscriptionId, { cancel_at_period_end: ending });
  await applySubscription(updated);
}
