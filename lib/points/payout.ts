import type { Prisma } from "@prisma/client";
import { award, type PointAward } from "@/lib/points/award";
import { publish } from "@/lib/agent-api/events";
import { releaseEscrow } from "@/lib/coins/escrow";

/**
 * Held payouts (#live-payout). Resolving an issue earns its solver the issue's
 * reward, its counted testers their reviewer awards and its dispatcher theirs,
 * but none of it is paid yet: it is held on the issue (`Bug.heldPayout`) until
 * `LIVE_REPORTS_NEEDED` people have reported the work deployed
 * (`POST /api/v1/issues/{id}/deployment`, one report per person counts). The
 * solver's own reports don't count. Once enough have, everything held is paid
 * at once, each award once by its source key.
 */
export const LIVE_REPORTS_NEEDED = 3;

type Tx = Prisma.TransactionClient;

function heldAwards(value: Prisma.JsonValue | null): PointAward[] {
  return Array.isArray(value) ? (value as unknown as PointAward[]).filter((entry) => entry && typeof entry.sourceKey === "string") : [];
}

/** People who reported the issue deployed, not counting its solver. */
export async function liveReporters(tx: Tx, bugId: string, solverUserId: string | null): Promise<string[]> {
  const reports = await tx.deploymentReport.findMany({ where: { bugId }, select: { onBehalfOfUserId: true } });
  return [...new Set(reports.map((report) => report.onBehalfOfUserId))].filter((userId) => userId !== solverUserId);
}

/**
 * Holds `awards` on the issue (merged with anything already held, by source
 * key), then pays them at once if enough people already reported it deployed.
 */
export async function holdPayout(tx: Tx, bugId: string, awards: PointAward[]): Promise<{ held: number; paid: boolean }> {
  const bug = await tx.bug.findUniqueOrThrow({ where: { id: bugId }, select: { heldPayout: true, payoutReleasedAt: true } });
  if (bug.payoutReleasedAt) {
    // Already released: anything new is paid straight away.
    for (const entry of awards) await award(tx, entry);
    return { held: 0, paid: true };
  }
  const merged = new Map(heldAwards(bug.heldPayout).map((entry) => [entry.sourceKey, entry]));
  for (const entry of awards) merged.set(entry.sourceKey, entry);
  await tx.bug.update({ where: { id: bugId }, data: { heldPayout: [...merged.values()] as unknown as Prisma.InputJsonValue } });
  const paid = await releasePayoutIfLive(tx, bugId);
  return { held: paid ? 0 : merged.size, paid };
}

/** Pays the issue's held awards once enough people reported it deployed. True if it paid them now. */
export async function releasePayoutIfLive(tx: Tx, bugId: string): Promise<boolean> {
  const bug = await tx.bug.findUniqueOrThrow({
    where: { id: bugId },
    select: { id: true, number: true, organisationId: true, projectId: true, assigneeId: true, heldPayout: true, payoutReleasedAt: true },
  });
  const held = heldAwards(bug.heldPayout);
  if (bug.payoutReleasedAt || held.length === 0) return false;
  const reporters = await liveReporters(tx, bug.id, bug.assigneeId);
  if (reporters.length < LIVE_REPORTS_NEEDED) return false;
  for (const entry of held) await award(tx, entry);
  await tx.bug.update({ where: { id: bug.id }, data: { heldPayout: [] as unknown as Prisma.InputJsonValue, payoutReleasedAt: new Date() } });
  // The Ziks behind the issue (lib/coins/escrow.ts) go out with the points: split by the same awards.
  await releaseEscrow(tx, bug.id, held);
  await publish(tx, {
    organisationId: bug.organisationId,
    type: "issue.updated",
    actorAgentId: null,
    bugId: bug.id,
    projectId: bug.projectId,
    payload: { issueId: bug.id, issueNumber: bug.number, payoutReleased: true, liveReports: reporters.length, awards: held.length },
  });
  return true;
}

/** What an issue's payout looks like now, for the issue JSON and page. */
export async function payoutState(tx: Tx, bugId: string) {
  const bug = await tx.bug.findUniqueOrThrow({ where: { id: bugId }, select: { assigneeId: true, heldPayout: true, payoutReleasedAt: true } });
  const held = heldAwards(bug.heldPayout);
  const reporters = await liveReporters(tx, bugId, bug.assigneeId);
  return {
    held: held.reduce((sum, entry) => sum + entry.points, 0),
    released: Boolean(bug.payoutReleasedAt),
    releasedAt: bug.payoutReleasedAt,
    liveReports: reporters.length,
    liveReportsNeeded: LIVE_REPORTS_NEEDED,
  };
}
