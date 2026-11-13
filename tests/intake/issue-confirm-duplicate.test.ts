import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_REVIEWER_POINTS, confirmationPointsAt } from "@/lib/points/rules";

/** Confirmation (#issue-confirmations, #confirmation-weights): weighted confirms, one entry per person per class, the move to Open, and duplicate decisions. */
type Entry = {
  id: string;
  bugId: string;
  onBehalfOfUserId: string;
  agentId: string | null;
  weightClass: string;
  verdict: "confirm" | "reject" | "neutral";
  summary: string;
  description: string;
  duplicateOfId: string | null;
  undoneAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const state = vi.hoisted(() => ({
  bug: {} as Record<string, unknown>,
  entries: [] as Entry[],
  agentOwners: {} as Record<string, string>,
  points: [] as Array<{ sourceKey: string; userId: string; role: string; points: number }>,
  clock: 0,
  otherIssues: [] as Array<{ id: string; number: number; project: { slug: string } }>,
}));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  bugRevision: { findMany: vi.fn() },
  bugActivity: { create: vi.fn() },
  issueConfirmation: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  pointEntry: { createMany: vi.fn() },
  confirmationPenalty: { findMany: vi.fn(async () => []) },
  closeSuggestion: {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => ({})),
    aggregate: vi.fn(),
    count: vi.fn(async () => 2),
    findMany: vi.fn(async () => [{ onBehalfOfUserId: "cara" }, { onBehalfOfUserId: "bob" }]),
  },
  comment: { create: vi.fn(async () => ({ id: "comment1" })) },
  user: { findUnique: vi.fn(async () => ({ name: "Ada" })) },
  issueClaim: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
  supportThread: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
  notification: { createMany: vi.fn() },
  // Closing refunds the issue's escrow; these issues were never funded.
  coinEntry: { aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })) },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
const publish = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-api/events", () => ({ publish }));
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/audit", () => ({ audit }));
vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ confirmationsNeeded: 2 })) }));
const notifyLater = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notifyLater }));

import { giveConfirmation, isConfirmed, openConfirmedIssue } from "@/lib/agent-api/confirmations";
import { agreeWithClose, respondToClose, suggestClose } from "@/lib/agent-api/close-suggestions";
import { workflowFor } from "@/lib/workflow";
import { IssueApiError } from "@/lib/agent-api/errors";
import { DUPLICATE_ERRORS, duplicateLinkProblem } from "@/lib/duplicates";

const scope = { organisationId: "t1", projectId: "p1" };
const agentOf = (id: string, owner: string) => {
  state.agentOwners[id] = owner;
  return { organisationId: "t1", userId: owner, agent: { id, level: "working" as const } };
};
const person = (userId: string) => ({ organisationId: "t1", userId });
const body = (verdict: string, extra: Record<string, unknown> = {}) => ({
  verdict,
  summary: "Reproduced it on staging.",
  description: "Followed the steps; it fails as reported and no other issue matches.",
  ...(verdict === "confirm" ? { files: [{ path: "lib/save.ts", lines: "42" }] } : {}),
  ...extra,
});

function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    number: 7,
    organisationId: "t1",
    projectId: "p1",
    status: "open", substatus: "requires_confirmation",
    isDeleted: false,
    reporterId: "ada",
    beneficiaryUserId: "ada",
    assigneeId: null,
    duplicateOfId: null,
    createdByAgentId: "agent-ada",
    createdByAgent: { ownerUserId: "ada" },
    idea: null,
    claims: [],
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<IssueApiError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(IssueApiError);
  return error as IssueApiError;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.bug = bugRow();
  state.entries = [];
  state.agentOwners = {};
  state.points = [];
  state.clock = 0;
  state.otherIssues = [{ id: "bug0", number: 3, project: { slug: "ziki" } }];
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([]);
  db.bug.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.id === state.bug.id || where.number === state.bug.number) return state.bug;
    return state.otherIssues.find((issue) => issue.id === where.id || issue.number === where.number) ?? null;
  });
  db.bug.findUnique.mockImplementation(async () => state.bug);
  db.bug.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.id === state.bug.id ? [state.bug] : state.otherIssues.filter((issue) => (where.id as { in?: string[] })?.in?.includes(issue.id)),
  );
  db.bug.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    state.bug = { ...state.bug, ...data };
    return state.bug;
  });
  db.bugRevision.findMany.mockResolvedValue([]);
  db.bugActivity.create.mockResolvedValue({});
  db.pointEntry.createMany.mockImplementation(async ({ data }: { data: Array<{ sourceKey: string; userId: string; role: string; points: number }> }) => {
    const fresh = data.filter((row) => !state.points.some((p) => p.sourceKey === row.sourceKey));
    state.points.push(...fresh);
    return { count: fresh.length };
  });
  type Key = { bugId_onBehalfOfUserId_weightClass: { onBehalfOfUserId: string; weightClass: string } };
  const byKey = (where: Key) => (e: Entry) =>
    e.onBehalfOfUserId === where.bugId_onBehalfOfUserId_weightClass.onBehalfOfUserId &&
    e.weightClass === where.bugId_onBehalfOfUserId_weightClass.weightClass;
  db.issueConfirmation.findUnique.mockImplementation(async ({ where }: { where: Key }) => state.entries.find(byKey(where)) ?? null);
  db.issueConfirmation.upsert.mockImplementation(async ({ where, create, update }: {
    where: Key;
    create: Omit<Entry, "id" | "createdAt" | "updatedAt">;
    update: Partial<Entry>;
  }) => {
    const at = new Date(Date.UTC(2026, 11, 4, 10, ++state.clock));
    const existing = state.entries.find(byKey(where));
    if (existing) {
      Object.assign(existing, update, { updatedAt: at });
      return existing;
    }
    const row = { ...create, id: `c${state.entries.length + 1}`, createdAt: at, updatedAt: at } as Entry;
    state.entries.push(row);
    return row;
  });
  db.issueConfirmation.findMany.mockImplementation(async ({ where }: { where: { verdict?: { in: string[] }; undoneAt?: null } }) =>
    state.entries
      .filter((e) => (!where.verdict || where.verdict.in.includes(e.verdict)) && (where.undoneAt !== null || !e.undoneAt))
      .map((e) => ({
        ...e,
        weightClass: e.weightClass ?? "working",
        attachments: [],
        agent: e.agentId ? { ownerUserId: state.agentOwners[e.agentId], name: e.agentId } : null,
        onBehalfOf: { name: e.onBehalfOfUserId },
        replies: [],
      })),
  );
});

describe("giveConfirmation (#issue-confirmations)", () => {
  it("records an agent's entry for its owner; two confirms confirm the issue, which then waits for an agent to open it", async () => {
    const first = await giveConfirmation(agentOf("agent-bob", "bob"), scope, "bug1", body("confirm"));
    expect(first).toMatchObject({ replaced: false, confirmed: false, newlyConfirmed: false, confirmations: 1, confirmationsNeeded: 2 });
    expect(first.confirmation).toMatchObject({ verdict: "confirm", onBehalfOfUserId: "bob", agentId: "agent-bob" });
    expect(first.confirmation).not.toHaveProperty("severity");

    const second = await giveConfirmation(person("cara"), scope, "7", body("confirm"));
    expect(second).toMatchObject({ confirmed: true, newlyConfirmed: true, opened: false, confirmations: 2 });
    // In a manager-governed project a confirmed issue stays until an agent moves it to Open (openConfirmedIssue).
    expect(state.bug.substatus).toBe("requires_confirmation");

    // Points: each counted confirm earns the reviewer award and the clearance; the reporter is paid once.
    expect(state.points.map((p) => p.sourceKey).sort()).toEqual([
      "reporter:bug1:ada",
      "reviewer-confirm:bug1:bob",
      "reviewer-confirm:bug1:cara",
      "triager-clear:bug1:bob",
      "triager-clear:bug1:cara",
    ]);
    // #confirmation-pay: the second confirmer is still among the first three, paid in full.
    expect(state.points.find((p) => p.sourceKey === "reviewer-confirm:bug1:cara")?.points).toBe(CONFIRMATION_REVIEWER_POINTS);

    // Events agents already subscribe to; only the agent's entry is audited.
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.confirmation", actorAgentId: "agent-bob" }));
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.confirmation", actorAgentId: null }));
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.confirmed" }));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      { agentId: "agent-bob", organisationId: "t1" },
      "issue.confirmation",
      "bug:bug1",
      expect.objectContaining({ confirmationId: first.confirmation.id, verdict: "confirm", entryAt: expect.any(String) }),
      expect.anything(),
    );
    expect(await isConfirmed("bug1")).toBe(true);
  });

  it("counts an issue made from an already-vetted idea as confirmed with no entries, and others only by their entries (#vetted-start-now)", async () => {
    expect(await isConfirmed("bug1")).toBe(false);
    state.bug = bugRow({ vettedAt: new Date(Date.UTC(2026, 10, 11)), status: "in_progress", substatus: "in_progress" });
    expect(await isConfirmed("bug1")).toBe(true);
  });

  it("refuses a bare verdict with 400 naming the field", async () => {
    const bare = await rejection(giveConfirmation(person("bob"), scope, "bug1", { verdict: "confirm" }));
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ error: "invalid_request", field: "summary" });
    const noDescription = await rejection(giveConfirmation(person("bob"), scope, "bug1", { verdict: "reject", summary: "Not real." }));
    expect(noDescription.body).toMatchObject({ field: "description" });
    const badVerdict = await rejection(giveConfirmation(person("bob"), scope, "bug1", body("accept")));
    expect(badVerdict.body).toMatchObject({ field: "verdict" });
    expect(db.issueConfirmation.upsert).not.toHaveBeenCalled();
  });

  it("lets the reporter confirm their own issue: it counts 1 and pays no confirmer points (#confirmation-weights)", async () => {
    const own = await giveConfirmation(person("ada"), scope, "bug1", body("confirm"));
    expect(own).toMatchObject({ confirmations: 1 });
    expect(state.points.filter((p) => p.userId === "ada" && p.sourceKey.startsWith("reviewer-confirm"))).toEqual([]);
    // The filing agent may confirm too; one person's agent of the same class replaces the entry.
    const filer = await giveConfirmation(agentOf("agent-ada", "ada"), scope, "bug1", body("confirm"));
    expect(filer).toMatchObject({ replaced: true, confirmations: 1 });
  });

  it("does not award reporter points to a public intake identity when the issue is confirmed", async () => {
    state.bug = bugRow({ idea: { source: "public" } });
    await giveConfirmation(person("bob"), scope, "bug1", body("confirm"));
    await giveConfirmation(person("cara"), scope, "bug1", body("confirm"));

    expect(state.points.map((point) => point.sourceKey)).not.toContain("reporter:bug1:ada");
    expect(state.points.map((point) => point.role).filter((role) => role === "reviewer")).toHaveLength(2);
  });

  it("keeps one entry per person per class: a manager agent's counts its weight beside the person's own (#confirmation-weights)", async () => {
    const manager = { organisationId: "t1", userId: "bob", agent: { id: "agent-bob-m", level: "manager" as const } };
    state.agentOwners["agent-bob-m"] = "bob";
    await giveConfirmation(person("bob"), scope, "bug1", body("confirm"));
    const both = await giveConfirmation(manager, scope, "bug1", body("confirm"));
    expect(both.confirmation.weightClass).toBe("manager");
    expect(both.replaced).toBe(false);
    expect(state.entries.filter((e) => e.onBehalfOfUserId === "bob")).toHaveLength(2);
  });

  it("refuses a marketing issue, which has no confirmation step, and writes and pays nothing", async () => {
    state.bug = bugRow({ track: "marketing", substatus: "open" });
    const refused = await rejection(giveConfirmation(person("bob"), scope, "bug1", body("confirm")));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "wrong_track" });
    expect(db.issueConfirmation.upsert).not.toHaveBeenCalled();
    expect(state.points).toEqual([]);
    const opener = { agentId: "agent-eli", ownerId: "eli", organisationId: "t1" };
    expect((await rejection(openConfirmedIssue(opener, scope, "bug1"))).body).toMatchObject({ error: "wrong_track" });
  });

  it("moves a confirmed issue to Open for any agent, and refuses below the threshold (#confirmation-weights)", async () => {
    const opener = { agentId: "agent-eli", ownerId: "eli", organisationId: "t1" };
    await giveConfirmation(person("bob"), scope, "bug1", body("confirm"));
    expect((await rejection(openConfirmedIssue(opener, scope, "bug1"))).body).toMatchObject({ error: "below_threshold", confirmations: 1, confirmationsNeeded: 2 });
    expect(state.bug.substatus).toBe("requires_confirmation");
    await giveConfirmation(person("cara"), scope, "bug1", body("confirm"));
    await expect(openConfirmedIssue(opener, scope, "bug1")).resolves.toMatchObject({ status: "open", substatus: "open", confirmations: 2 });
    expect(state.bug.substatus).toBe("open");
    expect((await rejection(openConfirmedIssue(opener, scope, "bug1"))).body).toMatchObject({ error: "not_confirming" });
  });

  it("takes no entries once a confirmed issue has left Requires confirmation, and 404s an unknown issue", async () => {
    await giveConfirmation(person("bob"), scope, "bug1", body("confirm"));
    await giveConfirmation(person("cara"), scope, "bug1", body("confirm"));
    state.bug = { ...state.bug, status: "open", substatus: "open" };
    expect((await rejection(giveConfirmation(person("dan"), scope, "bug1", body("confirm")))).body).toMatchObject({ error: "not_confirming" });
    state.bug = { ...state.bug, status: "in_progress", substatus: "in_progress" };
    expect((await rejection(giveConfirmation(person("dan"), scope, "bug1", body("confirm")))).body).toMatchObject({ error: "not_confirming" });
    expect((await rejection(giveConfirmation(person("bob"), scope, "nope", body("confirm")))).status).toBe(404);
  });

  it("still takes entries when the work started before the issue was confirmed (#open-award), without moving it", async () => {
    // Awarded at 1 of 2, then delivered and judged: the accept needs the missing confirmation.
    await giveConfirmation(person("bob"), scope, "bug1", body("confirm"));
    state.bug = { ...state.bug, status: "done", substatus: "accepted" };
    const last = await giveConfirmation(person("cara"), scope, "bug1", body("confirm"));
    expect(last).toMatchObject({ confirmed: true, newlyConfirmed: true, opened: false, confirmations: 2 });
    expect(state.bug.substatus).toBe("accepted");
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(await isConfirmed("bug1")).toBe(true);
    // The reporter is paid once, as for any confirmed issue.
    expect(state.points.filter((p) => p.sourceKey === "reporter:bug1:ada")).toHaveLength(1);
  });

  it("takes them at Open, In progress and Requires review too, but not after the fix is accepted or the issue is closed", async () => {
    for (const [status, substatus] of [["open", "open"], ["in_progress", "in_progress"], ["done", "requires_review"]] as const) {
      state.bug = bugRow({ status, substatus });
      state.entries = [];
      await expect(giveConfirmation(person("bob"), scope, "bug1", body("confirm"))).resolves.toMatchObject({ confirmations: 1 });
    }
    for (const [status, substatus] of [["merge", "ready_to_merge"], ["resolved", "on_dev"], ["closed", "closed"]] as const) {
      state.bug = bugRow({ status, substatus });
      state.entries = [];
      expect((await rejection(giveConfirmation(person("bob"), scope, "bug1", body("confirm")))).body).toMatchObject({ error: "not_confirming" });
    }
  });

  it("does not open an issue whose work already started, even in a threshold-only project", async () => {
    vi.mocked(workflowFor).mockImplementation(async () => ({ confirmationsNeeded: 2, governance: "threshold" }) as never);
    try {
      state.bug = bugRow({ status: "in_progress", substatus: "in_progress" });
      await giveConfirmation(person("bob"), scope, "bug1", body("confirm"));
      const last = await giveConfirmation(person("cara"), scope, "bug1", body("confirm"));
      expect(last).toMatchObject({ confirmed: true, opened: false });
      expect(state.bug.substatus).toBe("in_progress");
    } finally {
      vi.mocked(workflowFor).mockImplementation(async () => ({ confirmationsNeeded: 2 }) as never);
    }
  });

  it("marks a duplicate with a reject naming another issue, and pays the marker", async () => {
    const given = await giveConfirmation(person("bob"), scope, "bug1", body("reject", { duplicateOfId: "#3" }));
    expect(given.confirmation).toMatchObject({ verdict: "reject", duplicateOfId: "bug0" });
    expect(state.points.map((p) => p.sourceKey)).toEqual(["duplicate-marker:bug1:bob"]);
    expect((await rejection(giveConfirmation(person("cara"), scope, "bug1", body("reject", { duplicateOfId: "bug1" })))).body).toMatchObject({ field: "duplicateOfId" });

    // A duplicate earns its confirmers' reviewer award and its reporter nothing.
    await giveConfirmation(person("cara"), scope, "bug1", body("confirm"));
    const last = await giveConfirmation(person("dan"), scope, "bug1", body("confirm"));
    expect(last.confirmed).toBe(true);
    expect(state.points.map((p) => p.sourceKey).sort()).toEqual([
      "duplicate-marker:bug1:bob",
      "triager-clear:bug1:cara",
      "triager-clear:bug1:dan",
    ]);
  });

  it("replaces the person's earlier entry instead of adding one", async () => {
    await giveConfirmation(person("bob"), scope, "bug1", body("reject"));
    const changed = await giveConfirmation(agentOf("agent-bob", "bob"), scope, "bug1", body("confirm", { summary: "I was wrong." }));
    expect(changed).toMatchObject({ replaced: true, confirmations: 1 });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ verdict: "confirm", summary: "I was wrong.", agentId: "agent-bob", undoneAt: null });
  });
});

describe("confirmation pay (#confirmation-pay)", () => {
  it("pays the first three confirmers in full, halves the next three, and pays pile-ons nothing", () => {
    const paid = Array.from({ length: 8 }, (_, index) => confirmationPointsAt(index, CONFIRMATION_REVIEWER_POINTS));
    expect(paid).toEqual([0.9, 0.9, 0.9, 0.45, 0.225, 0.1125, 0, 0]);
    expect(confirmationPointsAt(-1, CONFIRMATION_REVIEWER_POINTS)).toBe(0);
  });
});

describe("duplicate links (#285)", () => {
  const side = (id: string, number: number, extra: Partial<{ isDeleted: boolean; duplicateOfId: string | null }> = {}) => ({ id, number, isDeleted: false, duplicateOfId: null, ...extra });
  const a = side("a", 1);
  const b = side("b", 2);

  it("allows a plain link and refuses a self link or a deleted target", () => {
    expect(duplicateLinkProblem(a, b, 0)).toBeNull();
    expect(duplicateLinkProblem(a, a, 0)).toBe(DUPLICATE_ERRORS.self);
    expect(duplicateLinkProblem(a, side("b", 2, { isDeleted: true }), 0)).toBe(DUPLICATE_ERRORS.targetDeleted);
  });

  it("refuses chains: a target that is a duplicate, or an issue that has duplicates", () => {
    expect(duplicateLinkProblem(a, side("b", 2, { duplicateOfId: "c" }), 0, { number: 3 })).not.toBeNull();
    expect(duplicateLinkProblem(a, b, 2)).not.toBeNull();
  });
});

describe("telling the owner about a close by votes (#your-decisions)", () => {
  const voter = { agentId: "agent-cara", name: "Docker", ownerId: "cara", organisationId: "t1", level: "working" as const, burst: false, keyId: "k1" };
  const notPlanned = { reason: "not_planned" as const, evidence: "The roadmap drops this screen in December.", summary: "We decided not to build this." };

  beforeEach(() => {
    state.bug = bugRow({ status: "open", substatus: "open", title: "Add a dark theme to the old settings screen" });
  });

  it("notifies the owner when the vote that reaches the threshold closes their issue, with the reason and evidence", async () => {
    vi.mocked(workflowFor).mockResolvedValueOnce({ governance: "threshold", closeThreshold: 3, managerVoteWeight: 2 } as never);
    db.closeSuggestion.aggregate.mockResolvedValueOnce({ _sum: { votes: 3 } });
    const result = await suggestClose(voter, "p1", "7", notPlanned);
    expect(result.closed).toBe(true);
    expect(notifyLater).toHaveBeenCalledTimes(1);
    const notice = notifyLater.mock.calls[0]![0];
    expect(notice).toMatchObject({ kind: "status_changed", reporterId: "ada", actorId: "cara", from: "open", to: "closed" });
    expect(notice.note).toContain("by 3 of 3 votes");
    expect(notice.note).toContain(notPlanned.evidence);
  });

  it("tells nobody when the owner's own votes closed it: there is no decision by others to show", async () => {
    vi.mocked(workflowFor).mockResolvedValueOnce({ governance: "threshold", closeThreshold: 3, managerVoteWeight: 2 } as never);
    db.closeSuggestion.aggregate.mockResolvedValueOnce({ _sum: { votes: 3 } });
    db.closeSuggestion.count.mockResolvedValueOnce(0);
    const result = await suggestClose(voter, "p1", "7", notPlanned);
    expect(result.closed).toBe(true);
    expect(db.closeSuggestion.count).toHaveBeenCalledWith({ where: { bugId: "bug1", reason: "not_planned", onBehalfOfUserId: { notIn: ["ada", "ada"] } } });
    expect(notifyLater).not.toHaveBeenCalled();
  });

  it("tells nobody while the votes are still below the threshold", async () => {
    vi.mocked(workflowFor).mockResolvedValueOnce({ governance: "threshold", closeThreshold: 3, managerVoteWeight: 2 } as never);
    db.closeSuggestion.aggregate.mockResolvedValueOnce({ _sum: { votes: 1 } });
    const result = await suggestClose(voter, "p1", "7", notPlanned);
    expect(result.closed).toBe(false);
    expect(notifyLater).not.toHaveBeenCalled();
  });
});

describe("the owner's answer to a close by votes (#your-decisions)", () => {
  const ada = { organisationId: "t1", userId: "ada" };
  const reply = { evidence: "#3 is about the desktop app; this is the mobile page, with its own screenshot." };

  beforeEach(() => {
    state.bug = bugRow({
      status: "closed", substatus: "closed", title: "Tabs are empty on mobile",
      closeReason: "duplicate", closeEvidence: "Same as #3.", duplicateOfId: "bug0", closedAt: new Date(),
    });
  });

  it("posts the owner's reply and tells the voters, leaving the close as it is", async () => {
    await respondToClose(ada, "p1", "7", reply);
    expect(db.comment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ authorId: "ada", body: reply.evidence }) }));
    expect(notifyLater).toHaveBeenCalledWith(expect.objectContaining({ kind: "comment_added", actorId: "ada", recipientIds: ["cara", "bob"] }));
    expect(state.bug).toMatchObject({ status: "closed", closeReason: "duplicate", duplicateOfId: "bug0" });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("records the owner's agreement, and refuses anyone else, an open issue or a withdrawal", async () => {
    await agreeWithClose(ada, "p1", "7");
    expect(state.bug.closeAgreedAt).toBeInstanceOf(Date);
    expect((await rejection(respondToClose({ organisationId: "t1", userId: "bob" }, "p1", "7", reply))).status).toBe(403);
    state.bug = { ...state.bug, status: "open", substatus: "open", closeReason: null };
    expect((await rejection(agreeWithClose(ada, "p1", "7"))).status).toBe(409);
    state.bug = { ...state.bug, status: "closed", substatus: "closed", closeReason: "withdrawn" };
    expect((await rejection(respondToClose(ada, "p1", "7", reply))).status).toBe(409);
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it("refuses a reply when nobody but the owner voted for the reason it closed with", async () => {
    db.closeSuggestion.count.mockResolvedValueOnce(0);
    expect((await rejection(respondToClose(ada, "p1", "7", reply))).status).toBe(409);
    expect(db.closeSuggestion.count).toHaveBeenCalledWith({ where: { bugId: "bug1", reason: "duplicate", onBehalfOfUserId: { not: "ada" } } });
    expect(db.comment.create).not.toHaveBeenCalled();
  });
});
