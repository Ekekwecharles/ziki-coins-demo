import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { account: string; userId?: string | null; bugId?: string | null; kind: string; amount: number; sourceKey: string };
type Where = Record<string, unknown>;

/** The ledger tables in memory, so the real ledger code runs against them. */
const world = vi.hoisted(() => ({
  rows: [] as Array<{ account: string; userId?: string | null; bugId?: string | null; kind: string; amount: number; sourceKey: string }>,
  purchases: [] as Array<{ stripeSessionId?: string; stripeInvoiceId?: string; subscriptionId?: string | null; userId?: string; zik?: number }>,
  /** Monthly plans (#ziki-coins): our mirror of Stripe's subscriptions, and what Stripe says each one is. */
  subscriptions: [] as Array<{ id: string; userId: string; stripeSubscriptionId: string; planId: string; status: string; cancelAtPeriodEnd: boolean }>,
  stripeSubscription: { id: "sub_1", status: "active", cancelAtPeriodEnd: false, userId: "owner", planId: "plus" },
  stripeCalls: [] as Array<{ name: string; args: unknown[] }>,
  withdrawals: [] as Array<{
    id: string;
    userId: string;
    zik: number;
    status: string;
    amountCents?: number;
    idempotencyKey?: string;
    stripeTransferId?: string | null;
    failureReason?: string | null;
    createdAt?: Date;
  }>,
  /** What Stripe's transfers.create does next; a test sets it. */
  transfer: { create: async (_params: unknown, _options: { idempotencyKey: string }): Promise<{ id: string }> => ({ id: "tr_default" }) },
  bug: { status: "open", payoutReleasedAt: null as Date | null, organisationId: "org", reporterId: "owner", isDeleted: false, reward: 1 },
  /** How many planning-poker estimates the issue has; the funding floor only applies once there is one. */
  estimates: 0,
}));

function matches(row: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === "object" && "in" in (want as object)) return ((want as { in: unknown[] }).in).includes(row[key]);
    return row[key] === want;
  });
}

const db = vi.hoisted(() => {
  const fake = {
    coinEntry: {
      createMany: async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const row of data) {
          if (world.rows.some((r) => r.sourceKey === row.sourceKey)) continue;
          if (row.amount === 0) throw new Error("amount must not be zero");
          world.rows.push({ userId: null, bugId: null, ...row });
          count += 1;
        }
        return { count };
      },
      aggregate: async ({ where }: { where: Where }) => {
        const found = world.rows.filter((r) => matches(r, where));
        return { _sum: { amount: found.length ? found.reduce((s, r) => s + r.amount, 0) : null } };
      },
      groupBy: async ({ by, where }: { by: string[]; where: Where }) => {
        const groups = new Map<string, { key: Record<string, unknown>; sum: number }>();
        for (const row of world.rows.filter((r) => matches(r, where))) {
          const key = Object.fromEntries(by.map((field) => [field, (row as Record<string, unknown>)[field]]));
          const id = JSON.stringify(key);
          const group = groups.get(id) ?? { key, sum: 0 };
          group.sum += row.amount;
          groups.set(id, group);
        }
        return [...groups.values()].map((g) => ({ ...g.key, _sum: { amount: g.sum } }));
      },
      findUnique: async ({ where }: { where: { sourceKey: string } }) => world.rows.find((r) => r.sourceKey === where.sourceKey) ?? null,
      count: async ({ where }: { where: Where }) => world.rows.filter((r) => matches(r, where)).length,
    },
    bug: {
      findUnique: async () => ({ ...world.bug }),
      findUniqueOrThrow: async () => ({ ...world.bug }),
    },
    rewardEstimate: { count: async () => world.estimates },
    membership: { findUnique: async () => null },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, stripeCustomerId: "cus_1" }),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id, stripeCustomerId: "cus_1" }),
      updateMany: async () => ({ count: 0 }),
    },
    coinPurchase: {
      findUnique: async ({ where }: { where: { stripeSessionId?: string; stripeInvoiceId?: string } }) =>
        world.purchases.find((p) => (where.stripeSessionId && p.stripeSessionId === where.stripeSessionId) || (where.stripeInvoiceId && p.stripeInvoiceId === where.stripeInvoiceId)) ?? null,
      create: async ({ data }: { data: { stripeSessionId?: string; stripeInvoiceId?: string } }) => {
        world.purchases.push(data);
        return { id: `purchase-${world.purchases.length}`, ...data };
      },
    },
    coinSubscription: {
      findUnique: async ({ where }: { where: { stripeSubscriptionId: string } }) => world.subscriptions.find((s) => s.stripeSubscriptionId === where.stripeSubscriptionId) ?? null,
      findFirst: async ({ where }: { where: { userId: string; status: { in: string[] } } }) =>
        world.subscriptions.find((s) => s.userId === where.userId && where.status.in.includes(s.status)) ?? null,
      upsert: async ({ where, create, update }: { where: { stripeSubscriptionId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const found = world.subscriptions.find((s) => s.stripeSubscriptionId === where.stripeSubscriptionId);
        if (found) return Object.assign(found, update);
        const made = { id: `csub-${world.subscriptions.length + 1}`, ...create } as (typeof world.subscriptions)[number];
        world.subscriptions.push(made);
        return made;
      },
    },
    withdrawal: {
      findUnique: async ({ where }: { where: { id: string } }) => world.withdrawals.find((w) => w.id === where.id) ?? null,
      findMany: async ({ where }: { where: { status: string; createdAt: { lt: Date } } }) =>
        world.withdrawals
          .filter((w) => w.status === where.status && (w.stripeTransferId ?? null) === null && (w.createdAt ?? new Date(0)) < where.createdAt.lt)
          .map((w) => ({ ...w, user: { stripeAccountId: "acct_fixer" } })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const found = world.withdrawals.filter((w) => {
          const row = w as Record<string, unknown>;
          return Object.entries(where).every(([key, want]) => {
            if (want && typeof want === "object" && "in" in (want as object)) return ((want as { in: unknown[] }).in).includes(row[key]);
            if (want === null) return (row[key] ?? null) === null;
            return row[key] === want;
          });
        });
        for (const w of found) Object.assign(w, data);
        return { count: found.length };
      },
    },
    $queryRaw: async () => [],
    $transaction: async (run: (tx: unknown) => unknown) => run(fake),
  };
  return fake;
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/coins/stripe", () => {
  /** A Stripe subscription as the API returns it, from what a test says it is. */
  const stripeSubscriptionNow = () => ({
    id: world.stripeSubscription.id,
    status: world.stripeSubscription.status,
    metadata: { userId: world.stripeSubscription.userId, planId: world.stripeSubscription.planId },
    cancel_at_period_end: world.stripeSubscription.cancelAtPeriodEnd,
    cancel_at: null,
    latest_invoice: "in_1",
    items: { data: [{ current_period_end: 1_800_000_000 }] },
  });
  return {
  getStripe: () => ({
    paymentIntents: { retrieve: async () => Promise.reject(new Error("offline")) },
    transfers: { create: (params: unknown, options: { idempotencyKey: string }) => world.transfer.create(params, options) },
    invoicePayments: { list: async () => Promise.reject(new Error("offline")) },
    invoices: { retrieve: async () => ({ hosted_invoice_url: "https://pay.stripe.test/in_1" }) },
    customers: { create: async () => ({ id: "cus_1" }) },
    subscriptions: {
      retrieve: async () => stripeSubscriptionNow(),
      update: async (id: string, params: { cancel_at_period_end: boolean }) => {
        world.stripeCalls.push({ name: "subscriptions.update", args: [id, params] });
        world.stripeSubscription.cancelAtPeriodEnd = params.cancel_at_period_end;
        return stripeSubscriptionNow();
      },
    },
    checkout: {
      sessions: {
        create: async (params: unknown) => {
          world.stripeCalls.push({ name: "checkout.sessions.create", args: [params] });
          return { url: "https://checkout.stripe.test/c_1" };
        },
      },
    },
  }),
  stripeConfigured: () => true,
  };
});
vi.mock("@/lib/site-url", () => ({ absoluteUrl: (path: string) => `https://ziki.test${path}` }));

import { fundIssue } from "@/lib/coins/fund";
import { refundEscrow, releaseEscrow } from "@/lib/coins/escrow";
import { escrowBalance, walletBalance, walletSummary } from "@/lib/coins/ledger";
import { estimateToZik, feeOf, planRelease, splitByWeight } from "@/lib/coins/math";
import { ledgerBalances } from "@/lib/coins/money";
import { createPackCheckout, recordPurchase } from "@/lib/coins/purchase";
import { discountedCents, planBreakEvenCents, ZIK_PLANS } from "@/lib/coins/plans";
import { createSubscriptionCheckout, recordSubscriptionPayment, setSubscriptionEnding } from "@/lib/coins/subscription";
import Stripe from "stripe";
import { failWithdrawal, retryPendingWithdrawals } from "@/lib/coins/withdraw";

const buy = (userId: string, zik: number, session: string) =>
  db.coinEntry.createMany({ data: [{ account: "wallet", userId, kind: "purchase", amount: zik, sourceKey: `purchase:${session}` }] });
const total = () => world.rows.reduce((sum, row) => sum + row.amount, 0);

beforeEach(() => {
  world.rows.length = 0;
  world.purchases.length = 0;
  world.subscriptions.length = 0;
  world.stripeCalls.length = 0;
  Object.assign(world.stripeSubscription, { id: "sub_1", status: "active", cancelAtPeriodEnd: false, userId: "owner", planId: "plus" });
  world.withdrawals.length = 0;
  world.transfer.create = async () => ({ id: "tr_default" });
  world.estimates = 0;
  Object.assign(world.bug, { status: "open", payoutReleasedAt: null, reward: 1 });
});

describe("Ziks arithmetic", () => {
  it("takes the fee first and splits the rest by award, handing out every Zik", () => {
    expect(feeOf(100, 10)).toBe(10);
    expect(feeOf(105, 10)).toBe(11);
    const plan = planRelease(100, new Map([["solver", 6], ["tester", 3]]), 10);
    expect(plan?.fee).toBe(10);
    expect([...(plan?.shares ?? [])]).toEqual([["solver", 60], ["tester", 30]]);
    // Thirds don't divide evenly: the split still adds up exactly.
    const odd = splitByWeight(100, new Map([["a", 1], ["b", 1], ["c", 1]]));
    expect([...odd.values()].reduce((s, n) => s + n, 0)).toBe(100);
  });

  it("turns a reward estimate in dollars into whole Ziks, never fewer than one", () => {
    expect(estimateToZik(6.33)).toBe(63);
    expect(estimateToZik(3.67)).toBe(37);
    expect(estimateToZik(10)).toBe(100);
    expect(estimateToZik(0.01)).toBe(1);
  });

  it("releases nothing when nobody earned anything", () => {
    expect(planRelease(100, new Map(), 10)).toBeNull();
  });
});

describe("funding an issue", () => {
  it("never takes a wallet below zero, and funds once per request", async () => {
    await buy("owner", 50, "s1");
    await expect(fundIssue("owner", "bug", 60, "request-0001")).rejects.toMatchObject({ code: "insufficient_ziks" });
    expect(await walletBalance(db as never, "owner")).toBe(50);

    expect(await fundIssue("owner", "bug", 20, "request-0002")).toEqual({ funded: true, escrow: 20 });
    expect(await fundIssue("owner", "bug", 20, "request-0002")).toEqual({ funded: false, escrow: 20 });
    expect(await walletBalance(db as never, "owner")).toBe(30);
    expect(total()).toBe(50);
  });

  it("won't fund an estimated issue below its estimate, but lets the owner add more once it is reached", async () => {
    await buy("owner", 500, "s7");
    world.estimates = 3;
    world.bug.reward = 6.33; // 63 Ziks

    await expect(fundIssue("owner", "bug", 40, "request-0007")).rejects.toMatchObject({ code: "invalid_amount" });
    expect(await walletBalance(db as never, "owner")).toBe(500);

    expect(await fundIssue("owner", "bug", 63, "request-0008")).toEqual({ funded: true, escrow: 63 });
    // At the estimate, any amount adds to it.
    expect(await fundIssue("owner", "bug", 5, "request-0009")).toEqual({ funded: true, escrow: 68 });
  });

  it("asks for only what is missing when an issue is partly funded, and ignores the $1 default before anyone estimates", async () => {
    await buy("owner", 500, "s8");
    // Nobody has estimated: the $1 default is not a floor, so one Zik is fine.
    expect(await fundIssue("owner", "bug", 1, "request-0010")).toEqual({ funded: true, escrow: 1 });

    world.estimates = 2;
    world.bug.reward = 5; // 50 Ziks, 1 already behind it
    await expect(fundIssue("owner", "bug", 48, "request-0011")).rejects.toMatchObject({ code: "invalid_amount" });
    expect(await fundIssue("owner", "bug", 49, "request-0012")).toEqual({ funded: true, escrow: 50 });
  });

  it("refuses someone who doesn't own the issue, and a finished issue", async () => {
    await buy("stranger", 50, "s2");
    await expect(fundIssue("stranger", "bug", 10, "request-0003")).rejects.toMatchObject({ code: "not_allowed" });
    await buy("owner", 50, "s3");
    world.bug.status = "closed";
    await expect(fundIssue("owner", "bug", 10, "request-0004")).rejects.toMatchObject({ code: "closed" });
  });
});

describe("releasing and refunding escrow", () => {
  it("pays the earners by their awards, keeps the fee, and balances to the Ziks bought", async () => {
    await buy("owner", 100, "s4");
    await fundIssue("owner", "bug", 100, "request-0005");
    const awards = [{ userId: "solver", points: 6 }, { userId: "tester", points: 3 }];

    const result = await releaseEscrow(db as never, "bug", awards);

    expect(result).toEqual({ released: 90, fee: 10, paidTo: ["solver", "tester"] });
    expect(await walletBalance(db as never, "solver")).toBe(60);
    expect(await walletBalance(db as never, "tester")).toBe(30);
    expect(await escrowBalance(db as never, "bug")).toBe(0);
    expect(world.rows.filter((r) => r.account === "revenue").reduce((s, r) => s + r.amount, 0)).toBe(10);
    expect(total()).toBe(100);
    expect(ledgerBalances({ bought: 100, withdrawn: 0, inLedger: total() }).difference).toBe(0);

    // The same release again finds the escrow empty and pays nothing more.
    expect(await releaseEscrow(db as never, "bug", awards)).toBeNull();
    expect(await walletBalance(db as never, "solver")).toBe(60);
  });

  it("gives unused escrow back to whoever funded it when the issue closes", async () => {
    await buy("owner", 100, "s5");
    await fundIssue("owner", "bug", 40, "request-0006");
    expect(await refundEscrow(db as never, "bug")).toBe(40);
    expect(await walletBalance(db as never, "owner")).toBe(100);
    expect(await escrowBalance(db as never, "bug")).toBe(0);
    expect(await refundEscrow(db as never, "bug")).toBe(0);
  });
});

describe("Stripe webhook purchases", () => {
  const session = (over: Record<string, unknown> = {}) =>
    ({ id: "cs_1", mode: "payment", payment_status: "paid", amount_total: 500, currency: "usd", payment_intent: "pi_1", metadata: { userId: "owner", packId: "starter" }, ...over }) as never;

  it("credits the wallet once, however many times Stripe delivers the event", async () => {
    expect(await recordPurchase(session())).toBe("recorded");
    expect(await recordPurchase(session())).toBe("duplicate");
    expect(await walletBalance(db as never, "owner")).toBe(50);
    expect(world.purchases).toHaveLength(1);
  });

  it("credits nothing for an unpaid session, or one that paid less than the pack costs", async () => {
    expect(await recordPurchase(session({ payment_status: "unpaid" }))).toBe("ignored");
    expect(await recordPurchase(session({ id: "cs_2", amount_total: 100 }))).toBe("ignored");
    expect(await walletBalance(db as never, "owner")).toBe(0);
  });
});

describe("Ziki plans (a discount on Ziks packs)", () => {
  const invoice = (over: Record<string, unknown> = {}) =>
    ({
      id: "in_1",
      status: "paid",
      billing_reason: "subscription_create",
      amount_paid: 500,
      currency: "usd",
      parent: { subscription_details: { subscription: "sub_1", metadata: { userId: "owner", planId: "plus" } } },
      ...over,
    }) as never;
  const live = (status = "active", planId = "pro") =>
    world.subscriptions.push({ id: "csub-9", userId: "owner", stripeSubscriptionId: "sub_1", planId, status, cancelAtPeriodEnd: false });
  const lastCheckout = () => world.stripeCalls.at(-1)?.args[0] as { mode: string; line_items: Array<{ price_data: { unit_amount: number; recurring?: { interval: string } } }>; metadata: Record<string, string>; subscription_data?: { metadata: unknown } };

  it("takes the plan's discount off a pack's price, to the cent", () => {
    expect(discountedCents(500, 0)).toBe(500);
    expect(discountedCents(500, 10)).toBe(450);
    expect(discountedCents(500, 15)).toBe(425);
    expect(discountedCents(15000, 20)).toBe(12000);
    expect(ZIK_PLANS.map((plan) => [plan.id, plan.monthlyCents, plan.discountPercent, planBreakEvenCents(plan)])).toEqual([
      ["plus", 500, 10, 5000],
      ["pro", 1500, 15, 10000],
      ["team", 4000, 20, 20000],
    ]);
  });

  it("records a paid month's fee once as income, and gives no Ziks for it", async () => {
    expect(await recordSubscriptionPayment(invoice())).toBe("recorded");
    expect(await recordSubscriptionPayment(invoice())).toBe("duplicate");
    expect(world.purchases).toHaveLength(1);
    expect(world.purchases[0]).toMatchObject({ stripeInvoiceId: "in_1", planId: "plus", zik: 0, amountCents: 500 });
    // The fee buys no Ziks: nothing reaches the wallet or the ledger.
    expect(await walletBalance(db as never, "owner")).toBe(0);
    expect(world.rows).toHaveLength(0);
    // The purchase points at our mirror of the subscription, made from Stripe's own record of it.
    expect(world.subscriptions).toHaveLength(1);
    expect(world.purchases[0].subscriptionId).toBe(world.subscriptions[0].id);

    // The next month's invoice is a separate payment.
    expect(await recordSubscriptionPayment(invoice({ id: "in_2", billing_reason: "subscription_cycle" }))).toBe("recorded");
    expect(world.purchases).toHaveLength(2);
  });

  it("records nothing for an unpaid invoice, a different amount, an unknown plan or one that isn't a plan's month", async () => {
    expect(await recordSubscriptionPayment(invoice({ status: "open" }))).toBe("ignored");
    expect(await recordSubscriptionPayment(invoice({ id: "in_2", amount_paid: 400 }))).toBe("ignored");
    expect(await recordSubscriptionPayment(invoice({ id: "in_3", parent: { subscription_details: { subscription: "sub_1", metadata: { userId: "owner", planId: "gold" } } } }))).toBe("ignored");
    expect(await recordSubscriptionPayment(invoice({ id: "in_4", billing_reason: "manual" }))).toBe("ignored");
    expect(await recordSubscriptionPayment(invoice({ id: "in_5", parent: null }))).toBe("ignored");
    expect(world.purchases).toHaveLength(0);
  });

  it("sends a person to Stripe for a plan at its monthly fee, and only lets them have one at a time", async () => {
    expect(await createSubscriptionCheckout("owner", "owner@ziki.test", "pro")).toBe("https://checkout.stripe.test/c_1");
    expect(lastCheckout().mode).toBe("subscription");
    expect(lastCheckout().line_items[0].price_data).toMatchObject({ unit_amount: 1500, recurring: { interval: "month" } });
    expect(lastCheckout().subscription_data?.metadata).toEqual({ userId: "owner", planId: "pro" });

    // Started from the pricing page, cancelling at Stripe comes back to it; otherwise to the Ziks page.
    await createSubscriptionCheckout("owner", undefined, "plus", "pricing");
    expect((lastCheckout() as unknown as { cancel_url: string }).cancel_url).toBe("https://ziki.test/pricing");
    await createSubscriptionCheckout("owner", undefined, "plus");
    expect((lastCheckout() as unknown as { cancel_url: string }).cancel_url).toBe("https://ziki.test/coins");

    await expect(createSubscriptionCheckout("owner", undefined, "gold")).rejects.toMatchObject({ code: "invalid_amount" });

    live();
    await expect(createSubscriptionCheckout("owner", undefined, "plus")).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("charges a subscriber the discounted price for a pack while the plan is paid up, and the full price otherwise", async () => {
    await createPackCheckout("owner", undefined, "starter");
    expect(lastCheckout().line_items[0].price_data.unit_amount).toBe(500);
    expect(lastCheckout().metadata.discountPercent).toBe("0");

    live("active", "pro");
    await createPackCheckout("owner", undefined, "starter");
    expect(lastCheckout().line_items[0].price_data.unit_amount).toBe(425);
    expect(lastCheckout().metadata).toMatchObject({ packId: "starter", zik: "50", discountPercent: "15" });

    // A plan whose payment failed gives no discount until it is paid.
    world.subscriptions[0].status = "past_due";
    await createPackCheckout("owner", undefined, "starter");
    expect(lastCheckout().line_items[0].price_data.unit_amount).toBe(500);
  });

  it("credits a discounted pack's full Ziks, but only for a price a plan really gives", async () => {
    const discounted = (over: Record<string, unknown> = {}) =>
      ({ id: "cs_9", mode: "payment", payment_status: "paid", amount_total: 425, currency: "usd", payment_intent: "pi_9", metadata: { userId: "owner", packId: "starter", discountPercent: "15" }, ...over }) as never;

    expect(await recordPurchase(discounted())).toBe("recorded");
    expect(await walletBalance(db as never, "owner")).toBe(50);
    expect(world.purchases.at(-1)).toMatchObject({ zik: 50, amountCents: 425 });

    // Paid less than the pack costs and claims no discount, or less than the discount it claims allows, or a
    // discount no plan gives: nothing is credited.
    expect(await recordPurchase(discounted({ id: "cs_10", metadata: { userId: "owner", packId: "starter" } }))).toBe("ignored");
    expect(await recordPurchase(discounted({ id: "cs_11", amount_total: 400 }))).toBe("ignored");
    expect(await recordPurchase(discounted({ id: "cs_12", amount_total: 450, metadata: { userId: "owner", packId: "starter", discountPercent: "12" } }))).toBe("ignored");
    expect(await walletBalance(db as never, "owner")).toBe(50);
  });

  it("ends and keeps only the person's own plan, at the end of the month they paid for", async () => {
    await expect(setSubscriptionEnding("stranger", true)).rejects.toMatchObject({ code: "not_found" });

    live("active", "plus");
    await setSubscriptionEnding("owner", true);
    expect(world.stripeCalls.at(-1)).toEqual({ name: "subscriptions.update", args: ["sub_1", { cancel_at_period_end: true }] });
    expect(world.subscriptions[0].cancelAtPeriodEnd).toBe(true);

    await setSubscriptionEnding("owner", false);
    expect(world.subscriptions[0].cancelAtPeriodEnd).toBe(false);
  });
});

describe("withdrawals", () => {
  it("lets a person withdraw what they earned, not what they bought", async () => {
    await buy("fixer", 500, "s6");
    expect((await walletSummary(db as never, "fixer")).withdrawable).toBe(0);
    await db.coinEntry.createMany({ data: [{ account: "wallet", userId: "fixer", kind: "release", amount: 120, sourceKey: "release:x:fixer:wallet" }] });
    expect(await walletSummary(db as never, "fixer")).toEqual({ balance: 620, earned: 120, withdrawable: 120 });
  });

  it("puts a failed transfer's Ziks back once, however many times Stripe says so", async () => {
    await db.coinEntry.createMany({
      data: [
        { account: "wallet", userId: "fixer", kind: "release", amount: 400, sourceKey: "release:y:fixer:wallet" },
        { account: "wallet", userId: "fixer", kind: "withdrawal", amount: -400, sourceKey: "withdrawal:w1" },
      ],
    });
    world.withdrawals.push({ id: "w1", userId: "fixer", zik: 400, status: "pending" });
    expect(await walletBalance(db as never, "fixer")).toBe(0);

    expect(await failWithdrawal("w1", "Stripe reversed the transfer.")).toBe(true);
    expect(await failWithdrawal("w1", "Stripe reversed the transfer.")).toBe(false);

    expect(await walletBalance(db as never, "fixer")).toBe(400);
    expect(world.withdrawals[0].status).toBe("failed");
    expect((await walletSummary(db as never, "fixer")).withdrawable).toBe(400);
  });

  describe("when Stripe is still holding the platform's money", () => {
    const noFundsYet = () =>
      Promise.reject(new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "balance_insufficient", message: "insufficient available funds" }));
    const debited = (id: string, createdAt: Date) => {
      world.withdrawals.push({ id, userId: "fixer", zik: 450, amountCents: 4500, status: "pending", idempotencyKey: `key-${id}`, stripeTransferId: null, createdAt });
      return db.coinEntry.createMany({
        data: [
          { account: "wallet", userId: "fixer", kind: "release", amount: 450, sourceKey: `release:${id}:fixer:wallet` },
          { account: "wallet", userId: "fixer", kind: "withdrawal", amount: -450, sourceKey: `withdrawal:${id}` },
        ],
      });
    };
    const now = new Date("2026-11-15T12:00:00Z");
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

    it("keeps the withdrawal waiting with the Ziks reserved, then sends it once the money is available", async () => {
      await debited("w3", minutesAgo(10));
      const usedKeys: string[] = [];
      world.transfer.create = (_params, options) => {
        usedKeys.push(options.idempotencyKey);
        return noFundsYet();
      };

      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 1, waiting: 1, sent: 0, returned: 0 });
      expect(world.withdrawals[0].status).toBe("pending");
      expect(await walletBalance(db as never, "fixer")).toBe(0);

      world.transfer.create = async (_params, options) => {
        usedKeys.push(options.idempotencyKey);
        return { id: "tr_1" };
      };
      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 1, sent: 1, waiting: 0 });
      expect(world.withdrawals[0].stripeTransferId).toBe("tr_1");
      // Stripe would replay the refusal for the first key, so the second try used a new one.
      expect(usedKeys[1]).not.toBe(usedKeys[0]);

      // Sent once: nothing left to retry.
      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 0 });
    });

    it("doesn't touch a withdrawal made moments ago, and gives the Ziks back after two weeks of waiting", async () => {
      await debited("w4", minutesAgo(0.5));
      world.transfer.create = noFundsYet;
      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 0 });

      world.withdrawals[0].createdAt = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 1, returned: 1 });
      expect(world.withdrawals[0].status).toBe("failed");
      expect(await walletBalance(db as never, "fixer")).toBe(450);
    });
  });
});
