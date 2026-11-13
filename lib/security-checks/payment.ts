import type { SecuritySeverity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CoinError, appendRows, assertCanSpend, lockUser, walletBalance } from "@/lib/coins/ledger";
import { SEVERITY_PRICE, unlockTotal } from "@/lib/security-checks";

/**
 * Unlocking fixes (#security-checks, plan C1). The scan is free; the client
 * pays per finding, by severity (SEVERITY_PRICE), all at once or the ones they
 * choose, in Ziks from their wallet (lib/coins). Unlocking sets
 * `SecurityCheckResult.unlockedAt`, which shows the finding's details and fix
 * (isResultUnlocked) and lets the engine pay its finder, once. The Ziks and the
 * unlock happen in one transaction: a person who can't cover the findings
 * unlocks none of them, and one who double-clicks pays once.
 */

export type UnlockOutcome =
  | { ok: true; unlocked: number; coins: number }
  | { ok: false; reason: "not_found" | "not_posted" | "nothing_to_unlock" }
  | { ok: false; reason: "insufficient_ziks"; needed: number; balance: number };

/** What one finding costs to unlock: its stored price, or its severity's for older results. */
export function findingPrice(result: { severity: SecuritySeverity; priceCoins: number | null }): number {
  return result.priceCoins ?? SEVERITY_PRICE[result.severity];
}

/**
 * Unlock findings on the person's own check: every locked one, or only those
 * listed. Only a check whose report is posted can be unlocked, and a finding
 * already unlocked is never charged again, so a double click is safe.
 * Someone else's check, even in the same workspace, is `not_found`.
 */
export async function unlockFindings(
  checkId: string,
  organisationId: string,
  userId: string,
  which: "all" | string[],
  now = new Date(),
): Promise<UnlockOutcome> {
  const check = await prisma.securityCheck.findFirst({
    where: { id: checkId, organisationId, requestedById: userId },
    select: { postedAt: true },
  });
  if (!check) return { ok: false, reason: "not_found" };
  if (!check.postedAt) return { ok: false, reason: "not_posted" };

  try {
    return await prisma.$transaction(async (tx): Promise<UnlockOutcome> => {
      await lockUser(tx, userId);
      const locked = await tx.securityCheckResult.findMany({
        where: { checkId, unlockedAt: null, ...(which === "all" ? {} : { id: { in: which } }) },
        select: { id: true, severity: true, priceCoins: true },
      });
      if (locked.length === 0) return { ok: false, reason: "nothing_to_unlock" };
      const total = unlockTotal(locked);
      if (total > 0) {
        try {
          await assertCanSpend(tx, userId, total);
        } catch (error) {
          if (error instanceof CoinError && error.code === "insufficient_ziks") {
            return { ok: false, reason: "insufficient_ziks", needed: total, balance: await walletBalance(tx, userId) };
          }
          throw error;
        }
      }
      const { count } = await tx.securityCheckResult.updateMany({
        where: { id: { in: locked.map((result) => result.id) }, checkId, unlockedAt: null },
        data: { unlockedAt: now },
      });
      // Someone unlocked some of them between our read and write: pay for none, let the caller look again.
      if (count !== locked.length) throw new CoinError("closed", "These findings changed while you were unlocking them.");
      const rows = locked.flatMap((result) => {
        const price = findingPrice(result);
        if (price <= 0) return [];
        return [
          { account: "wallet" as const, userId, kind: "check_payment" as const, amount: -price, sourceKey: `check:${result.id}:wallet` },
          { account: "revenue" as const, kind: "check_payment" as const, amount: price, sourceKey: `check:${result.id}:revenue` },
        ];
      });
      if (rows.length > 0) await appendRows(tx, rows);
      return { ok: true, unlocked: count, coins: total };
    });
  } catch (error) {
    if (error instanceof CoinError && error.code === "closed") return { ok: false, reason: "nothing_to_unlock" };
    throw error;
  }
}
