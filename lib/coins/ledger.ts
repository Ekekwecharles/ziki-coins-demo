import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The Ziks ledger (#ziki-coins). `CoinEntry` is append-only like `PointEntry`
 * (lib/points/award.ts): a balance is the sum of its rows, a correction is a new
 * row, nothing is edited or deleted (the database refuses both), and
 * `sourceKey` is unique so the same event written twice adds one row.
 *
 * A move between accounts is two rows written together, one negative and one
 * positive. Anything that spends takes a row lock on what it spends from, then
 * reads the balance, so two spends at once can't both pass the same balance.
 */

type Db = PrismaClient | Prisma.TransactionClient;
export type Tx = Prisma.TransactionClient;
export type CoinRow = Prisma.CoinEntryCreateManyInput;

export class CoinError extends Error {
  constructor(
    readonly code: "insufficient_ziks" | "invalid_amount" | "not_allowed" | "not_found" | "closed" | "payouts_not_ready" | "below_threshold" | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "CoinError";
  }
}

/** Whole, positive Ziks. */
export function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new CoinError("invalid_amount", "Enter a whole number of Ziks above zero.");
}

/**
 * Writes the rows unless their source keys exist. True if they were all
 * written now, false if the event had already been recorded. A pair is only
 * ever written inside one transaction, so it is both or neither.
 */
export async function appendRows(db: Db, rows: CoinRow[]): Promise<boolean> {
  const { count } = await db.coinEntry.createMany({ data: rows, skipDuplicates: true });
  return count === rows.length;
}

export async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
}

export async function lockBug(tx: Tx, bugId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} FOR UPDATE`;
}

export async function walletBalance(db: Db, userId: string): Promise<number> {
  const sum = await db.coinEntry.aggregate({ where: { account: "wallet", userId }, _sum: { amount: true } });
  return sum._sum.amount ?? 0;
}

export async function escrowBalance(db: Db, bugId: string): Promise<number> {
  const sum = await db.coinEntry.aggregate({ where: { account: "escrow", bugId }, _sum: { amount: true } });
  return sum._sum.amount ?? 0;
}

/**
 * What a person may withdraw: the Ziks they earned (released to them) less
 * what they already took out, never more than the wallet holds. Ziks they
 * bought are for spending on issues and checks, not for cashing out.
 */
export function withdrawableOf(balance: number, earnedNet: number): number {
  return Math.max(0, Math.min(balance, earnedNet));
}

export async function earnedNet(db: Db, userId: string): Promise<number> {
  const sum = await db.coinEntry.aggregate({
    where: { account: "wallet", userId, kind: { in: ["release", "withdrawal", "withdrawal_reversal"] } },
    _sum: { amount: true },
  });
  return sum._sum.amount ?? 0;
}

export async function walletSummary(db: Db, userId: string) {
  const [balance, earned] = await Promise.all([walletBalance(db, userId), earnedNet(db, userId)]);
  return { balance, earned, withdrawable: withdrawableOf(balance, earned) };
}

/** Takes `amount` out of a wallet in a row pair's first half, refusing to go below zero. Caller holds the user lock. */
export async function assertCanSpend(tx: Tx, userId: string, amount: number): Promise<void> {
  assertAmount(amount);
  const balance = await walletBalance(tx, userId);
  if (balance < amount) {
    throw new CoinError("insufficient_ziks", `You have ${balance} Ziks and this needs ${amount}.`);
  }
}
