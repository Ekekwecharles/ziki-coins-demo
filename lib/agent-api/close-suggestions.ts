import { closeSupportThreadsForIssue } from "@/lib/support-threads";
import { refundEscrow } from "@/lib/coins/escrow";
import { reopenSubstatus } from "@/lib/marketing/track";
import { z } from "zod";
import type { Prisma, PrismaClient, Status, Substatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { entryDescription, entrySummary } from "@/lib/agent-api/entry-fields";
import { isThresholdOnly, thresholdDecision, voteWeight, type ThresholdDecision } from "@/lib/governance";
import { statusChangedSummary, unboostedSummary } from "@/lib/activity-log";
import { isDone } from "@/lib/issue-state";
import { parseIssueRef, resolveIssueRef } from "@/lib/issue-ref";
import { workflowFor } from "@/lib/workflow";
import { DuplicateLinkRefused, linkDuplicate } from "@/lib/duplicate-link";
import {
  closeReasonLabel,
  closeTallies,
  isReopenable,
  ownsIssue,
  VOTED_CLOSE_REASONS,
  type CloseReason,
  type CloseTally,
  type VotedCloseReason,
} from "@/lib/close-reasons";
import { moveTo } from "@/lib/issue-substatus";
import { notifyLater } from "@/lib/notify";
import { decisionNote } from "@/lib/your-decision";
import { logger } from "@/lib/logger";

/**
 * Closing an issue (#close-superseded, #close-reasons). Any agent that
 * notices an issue should be closed suggests it, with a reason
 * (lib/close-reasons.ts: superseded, not_reproducible, already_implemented,
 * duplicate or not_planned), the evidence and a comment: one suggestion per
 * person per issue, a manager (or merger) agent's counting the project's
 * `managerVoteWeight`. Each reason is tallied apart. In a `manager`-governed
 * project, one reason reaching the project's `closeThreshold` does not close
 * the issue: it goes into the managers' queue (the `close_issue` work item),
 * and a manager agent closes it with that reason and the evidence. In a
 * threshold-only project the suggestion that reaches it closes the issue
 * (#vote-governance).
 *
 * Two more ways, both without votes: the issue's owner withdraws it (reason
 * `withdrawn`), and a manager agent reopens one
 * closed as not reproducible, with fresh evidence.
 *
 * Closing releases any live claim or offer and keeps everything else:
 * comments, judgements, deliveries and merge reviews.
 */
type Db = PrismaClient | Prisma.TransactionClient;

const evidenceField = z
  .string()
  .trim()
  .min(1, "Add the evidence: what shows it (a request id, a commit, the issue that owns it).")
  .max(10_000);

/** The issue that owns the same work: its number (`12`, `#12`) or id. */
const duplicateOfField = z.union([z.number().int().positive(), z.string().trim().min(1).max(191)]);

type IssueSink = { addIssue: (issue: { code: "custom"; path: string[]; message: string }) => void };

/** `duplicateOf` goes with reason duplicate, and only with it. */
function duplicateRule(body: { reason: string; duplicateOf?: unknown }, ctx: IssueSink) {
  if (body.reason === "duplicate" && body.duplicateOf === undefined) {
    ctx.addIssue({ code: "custom", path: ["duplicateOf"], message: "A duplicate names the issue that owns the same work: duplicateOf (its number or id)." });
  }
  if (body.reason !== "duplicate" && body.duplicateOf !== undefined) {
    ctx.addIssue({ code: "custom", path: ["duplicateOf"], message: "duplicateOf only goes with reason duplicate." });
  }
}

export const closeSuggestionSchema = z
  .object({
    reason: z.enum(VOTED_CLOSE_REASONS),
    summary: entrySummary,
    description: entryDescription.optional(),
    evidence: evidenceField,
    duplicateOf: duplicateOfField.optional(),
  })
  .strict()
  .superRefine(duplicateRule);

export const closeIssueSchema = z
  .object({ reason: z.enum(VOTED_CLOSE_REASONS), evidence: evidenceField, duplicateOf: duplicateOfField.optional() })
  .strict()
  .superRefine(duplicateRule);

/** The fresh reproduction that reopens an issue closed as not reproducible, e.g. a new request id. */
export const reopenIssueSchema = z.object({ evidence: evidenceField }).strict();
/** The owner's reply to a close by votes (#your-decisions): their side, with the evidence. */
export const respondToCloseSchema = z.object({ evidence: evidenceField }).strict();

export const withdrawIssueSchema = z
  .object({
    projectId: z.string().trim().min(1).max(191).optional(),
    /** Why the owner cancels it, when they say. */
    evidence: z.string().trim().max(10_000).optional(),
  })
  .strict();

export type CloseSuggestionInput = z.infer<typeof closeSuggestionSchema>;
export type CloseIssueInput = z.infer<typeof closeIssueSchema>;

/** Who closes, reopens or withdraws: a person, through one of their agents or in the web app. */
type Actor = { organisationId: string; userId: string; agentId: string | null; agentName: string | null };

function agentActor(agent: AgentContext): Actor {
  return { organisationId: agent.organisationId, userId: agent.ownerId, agentId: agent.agentId, agentName: agent.name };
}

/** The issue in the organisation's project, not deleted; 404 otherwise. */
async function issueInProject(organisationId: string, projectId: string, issueRef: string) {
  const resolved = await resolveIssueRef(prisma, parseIssueRef(issueRef), { organisationId });
  const bug = resolved && await prisma.bug.findFirst({
    where: { id: resolved.id, organisationId, projectId, isDeleted: false },
    select: { id: true, number: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found in this project.");
  return bug;
}

const lockedSelect = {
  track: true,
  status: true, substatus: true, isDeleted: true, isBoosted: true, closeReason: true,
  reporterId: true, beneficiaryUserId: true, assigneeId: true,
  createdByAgent: { select: { ownerUserId: true } },
} satisfies Prisma.BugSelect;

/** Locks the issue row and reads it again, inside the transaction. */
async function lockedRow(tx: Prisma.TransactionClient, bugId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} FOR UPDATE`;
  const bug = await tx.bug.findUnique({ where: { id: bugId }, select: lockedSelect });
  if (!bug || bug.isDeleted) throw new IssueApiError(404, "Issue not found in this project.");
  return bug;
}

/** The locked issue, refused when it is already closed or live (409 already_closed). */
async function lockedIssue(tx: Prisma.TransactionClient, bugId: string) {
  const bug = await lockedRow(tx, bugId);
  if (isDone(bug.status)) {
    const message = `This issue is already ${bug.status === "resolved" ? "live" : "closed"}.`;
    throw new IssueApiError(409, message, { error: "already_closed", message });
  }
  return bug;
}

/** Resolves `duplicateOf` (a number or an id) to another live issue in the organisation; 422 otherwise. */
async function duplicateTarget(tx: Prisma.TransactionClient, organisationId: string, bugId: string, raw: string | number): Promise<string> {
  const ref = parseIssueRef(String(raw).replace(/^#/, ""));
  const target = await resolveIssueRef(tx, ref, { organisationId });
  const live = target && await tx.bug.findFirst({ where: { id: target.id, organisationId, isDeleted: false }, select: { id: true } });
  if (!live || live.id === bugId) {
    const message = "duplicateOf must name another issue in this organisation.";
    throw new IssueApiError(422, message, { error: "invalid_duplicate", message, field: "duplicateOf" });
  }
  return live.id;
}

/** The suggestions' votes for one reason on an issue, added up. */
export async function closeTally(bugId: string, reason: CloseReason, db: Db = prisma): Promise<number> {
  const total = await db.closeSuggestion.aggregate({ where: { bugId, reason }, _sum: { votes: true } });
  return total._sum.votes ?? 0;
}

/**
 * `POST /api/v1/issues/{id}/close-suggestions` (#close-reasons): suggest
 * closing the issue for a reason, with the evidence, a summary (at most two
 * sentences) and an optional description. Reason duplicate names the issue
 * that owns the work in `duplicateOf`. Refused on a closed or live issue (409
 * already_closed). A newer suggestion from the same person replaces theirs.
 */
export async function suggestClose(agent: AgentContext, projectId: string, issueRef: string, input: CloseSuggestionInput) {
  requireLevel(agent, "working");
  const bug = await issueInProject(agent.organisationId, projectId, issueRef);
  const workflow = await workflowFor(projectId);
  const { closeThreshold } = workflow;
  const weight = voteWeight(agent.level, workflow.managerVoteWeight);
  // The status before the close, for the owner's notice (#your-decisions).
  let from: Status = "open";

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await lockedIssue(tx, bug.id);
    const duplicateOfId = input.duplicateOf !== undefined ? await duplicateTarget(tx, agent.organisationId, bug.id, input.duplicateOf) : null;
    from = fresh.status;
    const fields = {
      reason: input.reason,
      votes: weight,
      summary: input.summary,
      description: input.description ?? null,
      evidence: input.evidence,
      duplicateOfId,
      agentId: agent.agentId,
    };
    // One suggestion per person, at the highest weight any of their agents cast.
    const earlier = await tx.closeSuggestion.findUnique({
      where: { bugId_onBehalfOfUserId: { bugId: bug.id, onBehalfOfUserId: agent.ownerId } },
      select: { votes: true },
    });
    await tx.closeSuggestion.upsert({
      where: { bugId_onBehalfOfUserId: { bugId: bug.id, onBehalfOfUserId: agent.ownerId } },
      update: { ...fields, votes: Math.max(weight, earlier?.votes ?? 0) },
      create: { bugId: bug.id, onBehalfOfUserId: agent.ownerId, ...fields },
    });
    const votes = await closeTally(bug.id, input.reason, tx);
    await publish(tx, {
      organisationId: agent.organisationId,
      type: "issue.close_suggested",
      actorAgentId: agent.agentId,
      bugId: bug.id,
      projectId,
      payload: { issueId: bug.id, issueNumber: bug.number, reason: input.reason, evidence: input.evidence, duplicateOfId, votes, threshold: closeThreshold },
    });
    const reached = votes >= closeThreshold;
    // Threshold-only (#vote-governance): the suggestion that reaches the threshold closes it.
    if (reached && isThresholdOnly(workflow)) {
      const decision = thresholdDecision({ userId: agent.ownerId, agentId: agent.agentId }, votes, closeThreshold);
      const closed = await closeInTransaction(tx, agentActor(agent), projectId, bug, fresh, {
        reason: input.reason, evidence: input.evidence, duplicateOfId, votes, threshold: closeThreshold, decision,
      });
      return { issueId: bug.id, issueNumber: bug.number, reason: input.reason, votes, threshold: closeThreshold, queued: false, closed: true, releasedClaimIds: closed.releasedClaimIds };
    }
    return { issueId: bug.id, issueNumber: bug.number, reason: input.reason, votes, threshold: closeThreshold, queued: reached, closed: false, releasedClaimIds: [] as string[] };
  });
  await audit(agent, "issue.close_suggested", `issue:${bug.id}`, { reason: result.reason, votes: result.votes, queued: result.queued, closed: result.closed }, { bugId: bug.id });
  if (result.closed) {
    await audit(
      agent,
      "issue.closed",
      `issue:${bug.id}`,
      { reason: result.reason, evidence: input.evidence, votes: result.votes, threshold: result.threshold, via: "threshold", releasedClaimIds: result.releasedClaimIds },
      { bugId: bug.id },
    );
    await tellOwnerOfDecision(agent, bug.id, from, {
      reason: result.reason, evidence: input.evidence, votes: result.votes, threshold: result.threshold,
    });
  }
  return result;
}

/**
 * Tells the issue's owner that other people's votes closed it
 * (#your-decisions): a status-changed notice to its watchers, the reporter
 * first, whose note says what was decided, by how many votes and with what
 * evidence. Sent only when someone other than the owner voted for the reason,
 * the same rule as the decision card, so the notice never points the owner
 * at a card that isn't there. The voter whose agent closed it is not told
 * about their own act. A failure here never undoes the close.
 */
async function tellOwnerOfDecision(
  agent: AgentContext,
  bugId: string,
  from: Status,
  decision: { reason: string; evidence: string | null; votes?: number; threshold?: number },
) {
  try {
    const bug = await prisma.bug.findUnique({
      where: { id: bugId },
      select: { title: true, reporterId: true, beneficiaryUserId: true, duplicateOf: { select: { number: true, title: true } } },
    });
    if (!bug) return;
    const othersVoted = await prisma.closeSuggestion.count({
      where: { bugId, reason: decision.reason, onBehalfOfUserId: { notIn: [bug.reporterId, bug.beneficiaryUserId] } },
    });
    if (othersVoted === 0) return;
    notifyLater({
      kind: "status_changed",
      actorId: agent.ownerId,
      actorName: agent.name,
      bugId,
      bugTitle: bug.title,
      reporterId: bug.reporterId,
      from,
      to: "closed",
      note: decisionNote({
        reason: decision.reason,
        duplicateOf: bug.duplicateOf,
        votes: decision.votes,
        threshold: decision.threshold,
        evidence: decision.evidence,
      }),
    });
  } catch (error) {
    logger.error("[close] owner notice failed", { bugId, error });
  }
}

function duplicateRefused(error: unknown): never {
  if (error instanceof DuplicateLinkRefused) {
    throw new IssueApiError(409, error.message, { error: "duplicate_refused", message: error.message, field: "duplicateOf" });
  }
  throw error;
}

/**
 * Closes the locked issue with `reason` and its evidence, in the caller's
 * transaction: for a duplicate, marks it a duplicate of the other issue (the
 * one duplicate rule, lib/duplicate-link.ts); releases any live claim or offer
 * (reason `closed`); records the status change and publishes `issue.closed`.
 * A manager's close, the suggestion that reaches the threshold in a
 * threshold-only project (`decision`) and the owner's withdrawal all end here.
 */
async function closeInTransaction(
  tx: Prisma.TransactionClient,
  actor: Actor,
  projectId: string,
  bug: { id: string; number: number },
  fresh: { status: Status; substatus: Substatus; isBoosted: boolean },
  input: {
    reason: CloseReason;
    evidence: string | null;
    duplicateOfId?: string | null;
    votes?: number;
    threshold?: number;
    decision?: ThresholdDecision;
  },
) {
  const { reason, evidence } = input;
  if (reason === "duplicate") {
    if (!input.duplicateOfId) throw new IssueApiError(422, "A duplicate names the issue that owns the same work.", { error: "invalid_duplicate", field: "duplicateOf" });
    await linkDuplicate(tx, { organisationId: actor.organisationId, bugId: bug.id, targetId: input.duplicateOfId, actorId: actor.userId }).catch(duplicateRefused);
  }
  const claims = await tx.issueClaim.findMany({
    where: { bugId: bug.id, status: { in: ["offered", "planning", "active"] }, releasedAt: null },
    select: { id: true, agentId: true, beneficiaryUserId: true },
  });
  const now = new Date();
  if (claims.length) {
    await tx.issueClaim.updateMany({
      where: { id: { in: claims.map((claim) => claim.id) } },
      data: { status: "released", releasedAt: now, releaseReason: "closed" },
    });
  }
  await tx.bug.update({
    where: { id: bug.id },
    data: {
      ...moveTo("closed"),
      closeReason: reason,
      closeEvidence: evidence,
      closedAt: now,
      closeAgreedAt: null,
      // A finished issue shouldn't stay pinned above open work (#256).
      ...(fresh.isBoosted ? { isBoosted: false, boostedAt: null } : {}),
    },
  });
  await closeSupportThreadsForIssue(tx, {
    bugId: bug.id,
    reason: "issue_closed",
  });
  // Ziks still in the issue's escrow go back to whoever funded it (lib/coins/escrow.ts).
  await refundEscrow(tx, bug.id);
  await tx.bugActivity.create({
    data: {
      bugId: bug.id,
      actorId: actor.userId,
      type: "status_changed",
      summary: statusChangedSummary(fresh.substatus, "closed"),
      metadata: {
        field: "status", from: fresh.substatus, to: "closed", via: reason, evidence,
        ...(input.duplicateOfId ? { duplicateOfId: input.duplicateOfId } : {}),
        ...(input.votes !== undefined ? { votes: input.votes } : {}),
        agentId: actor.agentId, agentName: actor.agentName,
        // Who cast the deciding vote is the actor above; this says no manager closed it.
        ...(input.decision ? { decidedBy: input.decision.via, threshold: input.threshold } : {}),
      },
    },
  });
  if (fresh.isBoosted) {
    await tx.bugActivity.create({
      data: { bugId: bug.id, actorId: actor.userId, type: "unboosted", summary: unboostedSummary(), metadata: { field: "isBoosted", to: "false" } },
    });
  }
  for (const claim of claims) {
    await publish(tx, {
      organisationId: actor.organisationId,
      type: "claim.released",
      actorAgentId: claim.agentId,
      bugId: bug.id,
      projectId,
      payload: { claimId: claim.id, issueId: bug.id, projectId, beneficiaryUserId: claim.beneficiaryUserId, reason: "closed" },
    });
  }
  await publish(tx, {
    organisationId: actor.organisationId,
    type: "issue.closed",
    actorAgentId: actor.agentId,
    bugId: bug.id,
    projectId,
    payload: {
      issueId: bug.id, issueNumber: bug.number, from: fresh.status, reason, evidence,
      ...(input.duplicateOfId ? { duplicateOfId: input.duplicateOfId } : {}),
      ...(input.votes !== undefined ? { votes: input.votes, threshold: input.threshold } : {}),
      ...(reason === "withdrawn" ? { withdrawnByUserId: actor.userId } : {}),
      ...(input.decision ?? {}),
    },
  });
  return { releasedClaimIds: claims.map((claim) => claim.id), closedAt: now };
}

/**
 * `POST /api/v1/issues/{id}/close` (#close-reasons), manager level: close the
 * issue for `reason` (any but withdrawn) with the evidence, once the
 * suggestions for that reason reach `closeThreshold` (409 below_threshold
 * before that). Reason duplicate names the issue that owns the work in
 * `duplicateOf` and marks it a duplicate. In a threshold-only project the
 * suggestion that reaches the threshold has closed it already; this remains
 * for a threshold lowered after the votes were cast.
 */
export async function closeIssue(agent: AgentContext, projectId: string, issueRef: string, input: CloseIssueInput) {
  requireLevel(agent, "manager");
  const bug = await issueInProject(agent.organisationId, projectId, issueRef);
  const { closeThreshold } = await workflowFor(projectId);
  const reason: VotedCloseReason = input.reason;
  let from: Status = "open";

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await lockedIssue(tx, bug.id);
    from = fresh.status;
    const votes = await closeTally(bug.id, reason, tx);
    if (votes < closeThreshold) {
      const message = `${votes} of ${closeThreshold} votes suggest closing this issue as ${closeReasonLabel(reason)}; it can be closed for that reason once they reach the threshold.`;
      throw new IssueApiError(409, message, { error: "below_threshold", message, reason, votes, threshold: closeThreshold });
    }
    const duplicateOfId = input.duplicateOf !== undefined ? await duplicateTarget(tx, agent.organisationId, bug.id, input.duplicateOf) : null;
    const closed = await closeInTransaction(tx, agentActor(agent), projectId, bug, fresh, {
      reason, evidence: input.evidence, duplicateOfId, votes, threshold: closeThreshold,
    });
    return {
      issueId: bug.id,
      issueNumber: bug.number,
      ...moveTo("closed"),
      closeReason: reason,
      closeEvidence: input.evidence,
      duplicateOfId,
      votes,
      threshold: closeThreshold,
      releasedClaimIds: closed.releasedClaimIds,
    };
  });
  await audit(agent, "issue.closed", `issue:${bug.id}`, { reason, evidence: input.evidence, votes: result.votes, releasedClaimIds: result.releasedClaimIds }, { bugId: bug.id });
  await tellOwnerOfDecision(agent, bug.id, from, {
    reason, evidence: input.evidence, votes: result.votes, threshold: result.threshold,
  });
  return result;
}

/**
 * `POST /api/v1/issues/{id}/reopen` (#close-reasons), manager level, the
 * owner's own issue included (#owner-agents): reopen an issue closed as not reproducible, with
 * fresh evidence that reproduces it (a new request id, say). Any other close
 * is final (409 not_reopenable). It goes back to Open when it had been
 * confirmed, otherwise to Requires confirmation; its close reason and
 * evidence are cleared, and the not-reproducible suggestions the new evidence
 * answers are removed so they don't queue it again.
 */
export async function reopenIssue(agent: AgentContext, projectId: string, issueRef: string, input: z.infer<typeof reopenIssueSchema>) {
  requireLevel(agent, "manager");
  const bug = await issueInProject(agent.organisationId, projectId, issueRef);

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await lockedRow(tx, bug.id);
    if (fresh.status !== "closed" || !isReopenable(fresh.closeReason)) {
      const message = fresh.status === "closed"
        ? `Only an issue closed as not reproducible can be reopened; this one was closed${fresh.closeReason ? ` as ${closeReasonLabel(fresh.closeReason) ?? fresh.closeReason}` : ""}.`
        : "Only a closed issue can be reopened.";
      throw new IssueApiError(409, message, { error: "not_reopenable", message, status: fresh.status, closeReason: fresh.closeReason });
    }
    const to = reopenSubstatus(fresh.track, await isConfirmed(bug.id, tx));
    const previousReason = fresh.closeReason;
    await tx.bug.update({
      where: { id: bug.id },
      data: { ...moveTo(to), closeReason: null, closeEvidence: null, closedAt: null },
    });
    const { count: clearedSuggestions } = await tx.closeSuggestion.deleteMany({ where: { bugId: bug.id, reason: "not_reproducible" } });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: statusChangedSummary("closed", to),
        metadata: {
          field: "status", from: "closed", to, via: "reopened", previousReason, evidence: input.evidence,
          agentId: agent.agentId, agentName: agent.name,
        },
      },
    });
    await publish(tx, {
      organisationId: agent.organisationId,
      type: "issue.reopened",
      actorAgentId: agent.agentId,
      bugId: bug.id,
      projectId,
      payload: { issueId: bug.id, issueNumber: bug.number, from: "closed", to, previousReason, evidence: input.evidence },
    });
    return { issueId: bug.id, issueNumber: bug.number, ...moveTo(to), previousReason, evidence: input.evidence, clearedSuggestions };
  });
  await audit(agent, "issue.reopened", `issue:${bug.id}`, { from: "closed", to: result.substatus, previousReason: result.previousReason, evidence: input.evidence }, { bugId: bug.id });
  return result;
}

/** The issue's owner (its reporter or the person it is for), answering a close in the web app (#your-decisions). */
export type IssueOwner = { organisationId: string; userId: string };

/** The closed issue the owner may answer: theirs (403 otherwise), and closed by other members' votes (409 otherwise). */
async function ownersClosedIssue(tx: Prisma.TransactionClient, owner: IssueOwner, bugId: string) {
  const fresh = await lockedRow(tx, bugId);
  if (!ownsIssue(fresh, owner.userId)) throw new IssueApiError(403, "Only the person this issue belongs to can answer its close.", { error: "not_owner" });
  // Closed by votes means someone other than the owner suggested the reason it closed with (#your-decisions).
  const othersVoted = fresh.status === "closed" && fresh.closeReason && fresh.closeReason !== "withdrawn"
    ? await tx.closeSuggestion.count({ where: { bugId, reason: fresh.closeReason, onBehalfOfUserId: { not: owner.userId } } })
    : 0;
  if (othersVoted === 0) {
    const message = "Only an issue closed by other members' votes can be answered or agreed with.";
    throw new IssueApiError(409, message, { error: "not_appealable", message, status: fresh.status, closeReason: fresh.closeReason });
  }
  return fresh;
}

/**
 * The owner answers a close by other members' votes (#your-decisions): their
 * side, with the evidence, posted as a comment on the issue. The voters and
 * the issue's watchers are told. It changes nothing else: a close stays
 * final, and only a not-reproducible one can be reopened, by a manager agent
 * with the fresh reproduction (`reopenIssue`).
 */
export async function respondToClose(owner: IssueOwner, projectId: string, issueRef: string, input: z.infer<typeof respondToCloseSchema>) {
  const bug = await issueInProject(owner.organisationId, projectId, issueRef);
  const result = await prisma.$transaction(async (tx) => {
    const fresh = await ownersClosedIssue(tx, owner, bug.id);
    const voters = await tx.closeSuggestion.findMany({
      where: { bugId: bug.id, reason: fresh.closeReason!, onBehalfOfUserId: { not: owner.userId } },
      select: { onBehalfOfUserId: true },
    });
    const comment = await tx.comment.create({
      data: { bugId: bug.id, authorId: owner.userId, summary: "Reply to the close.", body: input.evidence },
      select: { id: true },
    });
    const ownerRow = await tx.user.findUnique({ where: { id: owner.userId }, select: { name: true } });
    const issue = await tx.bug.findUnique({ where: { id: bug.id }, select: { title: true } });
    return {
      issueId: bug.id, issueNumber: bug.number, commentId: comment.id, closeReason: fresh.closeReason,
      notice: { voterIds: voters.map((voter) => voter.onBehalfOfUserId), ownerName: ownerRow?.name ?? "The owner", title: issue?.title ?? "" },
    };
  });
  // The voters and the issue's watchers see the reply like any comment.
  const { notice, ...response } = result;
  notifyLater({
    kind: "comment_added",
    actorId: owner.userId,
    actorName: notice.ownerName,
    bugId: bug.id,
    bugTitle: notice.title,
    commentId: response.commentId,
    excerpt: input.evidence.slice(0, 200),
    recipientIds: notice.voterIds,
  });
  return response;
}

/** The owner agrees with a close by other members' votes (#your-decisions): the decision card folds away. */
export async function agreeWithClose(owner: IssueOwner, projectId: string, issueRef: string) {
  const bug = await issueInProject(owner.organisationId, projectId, issueRef);
  return prisma.$transaction(async (tx) => {
    const fresh = await ownersClosedIssue(tx, owner, bug.id);
    const agreedAt = new Date();
    await tx.bug.update({ where: { id: bug.id }, data: { closeAgreedAt: agreedAt } });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: owner.userId,
        type: "edited",
        summary: "agreed with the close",
        metadata: { field: "closeAgreedAt", to: agreedAt.toISOString(), reason: fresh.closeReason },
      },
    });
    return { issueId: bug.id, issueNumber: bug.number, agreedAt };
  });
}

/** Who withdraws an issue: a person, through one of their agents or in the web app. */
export type IssueWithdrawer = { organisationId: string; userId: string; agentId: string | null; agentName: string | null };

/**
 * The issue's owner withdraws it (#close-reasons): its reporter or the person
 * it is for, through any of their agents or in the web app. It closes at once
 * with reason `withdrawn` and the optional evidence: no votes, no manager.
 * Anyone else gets 403 not_issue_owner; a closed or live issue 409
 * already_closed.
 */
export async function withdrawIssue(withdrawer: IssueWithdrawer, projectId: string, issueRef: string, input: { evidence?: string } = {}) {
  const bug = await issueInProject(withdrawer.organisationId, projectId, issueRef);
  const evidence = input.evidence?.trim() ? input.evidence.trim() : null;
  const result = await prisma.$transaction(async (tx) => {
    const fresh = await lockedRow(tx, bug.id);
    if (!ownsIssue(fresh, withdrawer.userId)) {
      const message = "Only the issue's reporter or the person it is for can withdraw it.";
      throw new IssueApiError(403, message, { error: "not_issue_owner", message });
    }
    if (isDone(fresh.status)) {
      const message = `This issue is already ${fresh.status === "resolved" ? "live" : "closed"}.`;
      throw new IssueApiError(409, message, { error: "already_closed", message });
    }
    const closed = await closeInTransaction(tx, withdrawer, projectId, bug, fresh, { reason: "withdrawn", evidence });
    return {
      issueId: bug.id,
      issueNumber: bug.number,
      ...moveTo("closed"),
      closeReason: "withdrawn" as const,
      closeEvidence: evidence,
      closedAt: closed.closedAt.toISOString(),
      releasedClaimIds: closed.releasedClaimIds,
    };
  });
  // The agent audit log keeps an agent's withdrawal; a person's is in the event.
  if (withdrawer.agentId) {
    await audit({ agentId: withdrawer.agentId, organisationId: withdrawer.organisationId }, "issue.closed", `issue:${bug.id}`, {
      reason: "withdrawn", evidence, releasedClaimIds: result.releasedClaimIds,
    }, { bugId: bug.id });
  }
  return result;
}

export type CloseSuggestionView = {
  id: string;
  reason: string;
  votes: number;
  summary: string;
  description: string | null;
  evidence: string | null;
  /** For reason duplicate: the issue that owns the work. */
  duplicateOf: { number: number } | null;
  onBehalfOfUserId: string;
  by: string;
  agentName: string | null;
  updatedAt: Date;
};

export type CloseSuggestionsData = {
  entries: CloseSuggestionView[];
  /** Votes per reason, highest first; the first is the leading reason. */
  tallies: CloseTally[];
  /** The project's closeThreshold: one reason must reach it. */
  threshold: number;
  /** True when the suggestion that reaches the threshold closes the issue (#vote-governance). */
  thresholdOnly: boolean;
  managerVoteWeight: number;
};

/** An issue's close suggestions for its page, oldest first, with the tally per reason. Null for an unknown issue. */
export async function closeSuggestionsFor(bugId: string): Promise<CloseSuggestionsData | null> {
  const bug = await prisma.bug.findUnique({ where: { id: bugId }, select: { projectId: true } });
  if (!bug) return null;
  const [rows, workflow] = await Promise.all([
    prisma.closeSuggestion.findMany({
      where: { bugId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true, reason: true, votes: true, summary: true, description: true, evidence: true, onBehalfOfUserId: true, updatedAt: true,
        duplicateOf: { select: { number: true } },
        onBehalfOf: { select: { name: true } },
        agent: { select: { name: true } },
      },
    }),
    workflowFor(bug.projectId),
  ]);
  const entries = rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    votes: row.votes,
    summary: row.summary,
    description: row.description,
    evidence: row.evidence,
    duplicateOf: row.duplicateOf ?? null,
    onBehalfOfUserId: row.onBehalfOfUserId,
    by: row.onBehalfOf.name,
    agentName: row.agent?.name ?? null,
    updatedAt: row.updatedAt,
  }));
  return {
    entries,
    tallies: closeTallies(entries),
    threshold: workflow.closeThreshold,
    thresholdOnly: isThresholdOnly(workflow),
    managerVoteWeight: workflow.managerVoteWeight,
  };
}
