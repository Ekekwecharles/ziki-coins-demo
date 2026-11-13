import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { formatUsd, formatZik, zikToCents } from "@/lib/coins/math";
import { moneyTotals, reconcile } from "@/lib/coins/money";
import { getStripe, stripeConfigured } from "@/lib/coins/stripe";

export const metadata = { title: "Money" };
export const dynamic = "force-dynamic";

const card = "rounded-xl border border-zk-border bg-zk-surface p-4";

/**
 * Money (#ziki-coins): what has been bought, what is held on issues, what is owed
 * to earners, what has been withdrawn and what Ziki keeps, straight off the
 * ledger, with Stripe's balance checked against it. Read only.
 */
export default async function MoneyPage() {
  await requireSuperAdmin();
  const totals = await moneyTotals(prisma);
  const check = await reconcile(prisma, totals, async () => {
    if (!stripeConfigured()) throw new Error("Stripe isn't configured on this deployment.");
    const balance = await getStripe().balance.retrieve();
    const sum = (rows: { amount: number; currency: string }[]) => rows.filter((row) => row.currency === "usd").reduce((acc, row) => acc + row.amount, 0);
    return { availableCents: sum(balance.available), pendingCents: sum(balance.pending) };
  });

  const tiles = [
    { label: "Total bought", zik: totals.bought, note: "Ziks paid for through Stripe" },
    { label: "Held in escrow", zik: totals.inEscrow, note: "Behind issues, not yet paid out" },
    { label: "Owed to earners", zik: totals.owedToEarners, note: "Earned and not yet withdrawn" },
    { label: "Withdrawn", zik: totals.withdrawn, note: totals.pendingWithdrawals > 0 ? `${formatZik(totals.pendingWithdrawals)} still on its way` : "Sent to earners' Stripe accounts" },
    { label: "Ziki revenue", zik: totals.revenue, note: `${formatZik(totals.revenueFromFees)} fees, ${formatZik(totals.revenueFromChecks)} security checks` },
    { label: "Held by buyers", zik: totals.spendable, note: "Bought or refunded Ziks, still to spend" },
  ];
  const balanced = check.ledger.difference === 0;
  const stripeTotal = check.stripe ? check.stripe.availableCents + check.stripe.pendingCents : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm">
          <Link href="/superadmin/users" className="font-medium text-zk-accent hover:underline">← Site admin</Link>
        </p>
        <h1 className="mt-2 text-xl font-semibold text-zk-text sm:text-2xl">Money</h1>
        <p className="mt-1 max-w-2xl text-sm text-zk-text2">Every figure is the sum of the Ziks ledger. One Zik is {zikToCents(1)}¢.</p>
      </div>

      <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <li key={tile.label} className={card}>
            <p className="m-0 text-xs font-bold uppercase tracking-wide text-zk-muted">{tile.label}</p>
            <p className="m-0 mt-2 text-2xl font-extrabold tabular-nums text-zk-text">{tile.zik.toLocaleString("en-US")} <span className="text-sm font-medium text-zk-muted">Ziks</span></p>
            <p className="m-0 text-sm text-zk-text2">{formatUsd(zikToCents(tile.zik))}</p>
            <p className="m-0 mt-1 text-xs text-zk-muted">{tile.note}</p>
          </li>
        ))}
      </ul>

      <section aria-labelledby="reconcile" className={card}>
        <h2 id="reconcile" className="m-0 text-base font-semibold text-zk-text">Reconciliation</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-zk-muted">Ledger: accounts hold</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-zk-text">{totals.inLedger.toLocaleString("en-US")} Ziks</dd>
          </div>
          <div>
            <dt className="text-xs text-zk-muted">Ledger: bought less withdrawn</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-zk-text">{check.ledger.expected.toLocaleString("en-US")} Ziks</dd>
          </div>
          <div>
            <dt className="text-xs text-zk-muted">Stripe balance (available + pending)</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-zk-text">{stripeTotal === null ? "Not available" : formatUsd(stripeTotal)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zk-muted">Expected from the ledger (paid, less Stripe fees and transfers)</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-zk-text">{formatUsd(check.expectedCents)}</dd>
          </div>
        </dl>
        <p role="status" className={`mb-0 mt-4 rounded-lg px-3 py-2 text-sm font-semibold ${balanced && check.differenceCents === 0 ? "bg-zk-ok-bg text-zk-ok-fg" : "bg-zk-warn-bg text-zk-warn-fg"}`}>
          {!balanced
            ? `The ledger is out by ${Math.abs(check.ledger.difference).toLocaleString("en-US")} Ziks. A row was written on one side only.`
            : check.stripeError
              ? `The ledger balances. Stripe couldn't be read: ${check.stripeError}`
              : check.differenceCents === 0
                ? "The ledger balances and matches Stripe."
                : `The ledger balances. Stripe holds ${formatUsd(Math.abs(check.differenceCents ?? 0))} ${((check.differenceCents ?? 0) > 0) ? "more" : "less"} than the ledger expects.`}
        </p>
      </section>
    </div>
  );
}
