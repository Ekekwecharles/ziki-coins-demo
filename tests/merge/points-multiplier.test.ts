import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-api/pull-request-report", () => ({ reportedClosedUnmerged: vi.fn(async () => false) }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => ({ id: "evt" })) }));

import { award } from "@/lib/points/award";
import { correct } from "@/lib/points/correct";
import { pointsMultiplierFor, scaledPoints } from "@/lib/points/multiplier";
import { holdPayout, releasePayoutIfLive } from "@/lib/points/payout";

/** An in-memory ledger with the unique `sourceKey` the database enforces, and each organisation's multiplier. */
function fakeDb(multipliers: Record<string, number | string>, reporters: string[] = ["a", "b", "c"]) {
  const rows: Array<Record<string, unknown>> = [];
  const bug = { id: "bug-1", number: 1, organisationId: "zedu", projectId: "p1", assigneeId: "solver", heldPayout: null as unknown, payoutReleasedAt: null as Date | null };
  const db = {
    organisation: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id in multipliers ? { pointsMultiplier: multipliers[where.id] } : null)) },
    pointEntry: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        let count = 0;
        for (const row of data) {
          if (rows.some((r) => r.sourceKey === row.sourceKey)) continue;
          rows.push(row);
          count++;
        }
        return { count };
      }),
      update: vi.fn(async () => ({})),
    },
    bug: {
      findUniqueOrThrow: vi.fn(async () => ({ ...bug })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(bug, data)),
    },
    deploymentReport: { findMany: vi.fn(async () => reporters.map((onBehalfOfUserId) => ({ onBehalfOfUserId }))) },
    // An issue nobody funded: its escrow is empty, so releasing the payout moves no Ziks.
    coinEntry: { aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })) },
    $queryRaw: vi.fn(async () => []),
  };
  return { db: db as never, rows };
}

const base = { userId: "u1", bugId: "bug-1", role: "reviewer" as const };

describe("a organisation's points multiplier (#points-multiplier)", () => {
  it("multiplies every award written in that organisation, and no other", async () => {
    const { db, rows } = fakeDb({ zedu: "20.00", other: 1 });
    await award(db, { ...base, organisationId: "zedu", points: 0.9, sourceKey: "a" });
    await award(db, { ...base, organisationId: "zedu", points: 0.01, sourceKey: "b" });
    await award(db, { ...base, organisationId: "zedu", points: 6, role: "solver", sourceKey: "c" });
    await award(db, { ...base, organisationId: "other", points: 0.9, sourceKey: "d" });
    expect(rows.map((row) => [row.sourceKey, row.points])).toEqual([["a", 18], ["b", 0.2], ["c", 120], ["d", 0.9]]);
  });

  it("keeps the ledger's rounding when a multiplier leaves a long fraction", async () => {
    const { db, rows } = fakeDb({ zedu: 20 });
    await award(db, { ...base, organisationId: "zedu", points: 0.1125, sourceKey: "a" });
    await award(db, { ...base, organisationId: "zedu", points: 0.0001, sourceKey: "b" });
    expect(rows.map((row) => row.points)).toEqual([2.25, 0.002]);
  });

  it("writes an award once however many times it is asked, and does not store the exact flag", async () => {
    const { db, rows } = fakeDb({ zedu: 20 });
    expect(await award(db, { ...base, organisationId: "zedu", points: 1, sourceKey: "a" })).toBe(true);
    expect(await award(db, { ...base, organisationId: "zedu", points: 1, sourceKey: "a" })).toBe(false);
    expect(rows).toHaveLength(1);
    expect("exact" in rows[0]!).toBe(false);
  });

  it("stores an amount read from the ledger as it is (exact), so a penalty is not multiplied twice", async () => {
    const { db, rows } = fakeDb({ zedu: 20 });
    await award(db, { ...base, organisationId: "zedu", points: 18, sourceKey: "penalty", exact: true });
    expect(rows[0]!.points).toBe(18);
  });

  it("reverses a multiplied entry by exactly its amount", async () => {
    const { db, rows } = fakeDb({ zedu: 20 });
    await award(db, { ...base, organisationId: "zedu", points: 3, sourceKey: "reviewer:bug-1:u1" });
    const entry = { id: "e1", organisationId: "zedu", userId: "u1", bugId: "bug-1", role: "reviewer" as const, points: rows[0]!.points as number };
    expect(entry.points).toBe(60);
    await correct(db, { entry });
    expect(rows.map((row) => row.points)).toEqual([60, -60]);
  });

  it("pays a payout held before the change at the new multiplier when it is released", async () => {
    const reporters = ["solver", "a", "b"];
    const { db, rows } = fakeDb({ zedu: 20 }, reporters);
    const solver = { organisationId: "zedu", userId: "solver", bugId: "bug-1", role: "solver" as const, points: 6, sourceKey: "solver:bug-1:solver" };
    const tester = { organisationId: "zedu", userId: "tester", bugId: "bug-1", role: "reviewer" as const, points: 3, sourceKey: "reviewer:bug-1:tester" };
    expect(await holdPayout(db, "bug-1", [solver, tester])).toEqual({ held: 2, paid: false });
    expect(rows).toEqual([]);
    reporters.push("c");
    expect(await releasePayoutIfLive(db, "bug-1")).toBe(true);
    expect(rows.map((row) => [row.userId, row.points])).toEqual([["solver", 120], ["tester", 60]]);
  });

  it("counts a missing, zero or unreadable multiplier as 1", async () => {
    const { db } = fakeDb({ none: 0, junk: "nope" });
    expect(await pointsMultiplierFor(db, "none")).toBe(1);
    expect(await pointsMultiplierFor(db, "junk")).toBe(1);
    expect(await pointsMultiplierFor(db, "unknown-organisation")).toBe(1);
    expect(scaledPoints(1.5, 1)).toBe(1.5);
  });
});
