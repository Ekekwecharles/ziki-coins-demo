/**
 * `pnpm db:coins:accounts` (#ziki-coins): three accounts to try Ziks with, on a database that is already
 * migrated. A workspace owner, a fixer and a super admin, in one workspace with one project and one issue the fixer
 * is working on. Additive and idempotent: it only touches its own rows (users `*@ziki-coins.test`, organisation slug
 * `coins`), never resets or reseeds, and never gives anyone Ziks; they are bought through Stripe.
 *
 * Sign-in with email and password needs AUTH_PASSWORD_LOGIN=true on the deployment.
 * Override the password with COINS_ACCOUNTS_PASSWORD; the super admin's email with SUPER_ADMIN_EMAIL.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const PASSWORD = process.env.COINS_ACCOUNTS_PASSWORD?.trim() || "ziki-coins-2026";

const ACCOUNTS = [
  { key: "owner", name: "Olivia Owner", email: "owner@ziki-coins.test", role: "user" as const, membership: "owner" as const },
  { key: "fixer", name: "Felix Fixer", email: "fixer@ziki-coins.test", role: "user" as const, membership: "member" as const },
  { key: "admin", name: "Sam Super Admin", email: process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase() || "admin@ziki-coins.test", role: "super_admin" as const, membership: "admin" as const },
];

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const users: Record<string, { id: string; email: string }> = {};
  for (const account of ACCOUNTS) {
    users[account.key] = await prisma.user.upsert({
      where: { email: account.email },
      update: { name: account.name, role: account.role, passwordHash, emailVerified: new Date() },
      create: { name: account.name, email: account.email, role: account.role, passwordHash, emailVerified: new Date() },
      select: { id: true, email: true },
    });
  }

  const organisation = await prisma.organisation.upsert({
    where: { slug: "coins" },
    update: {},
    create: { slug: "coins", name: "Coins workspace", description: "Buy Ziks, fund an issue and get paid." },
  });
  for (const account of ACCOUNTS) {
    await prisma.membership.upsert({
      where: { organisationId_userId: { organisationId: organisation.id, userId: users[account.key].id } },
      update: { role: account.membership },
      create: { organisationId: organisation.id, userId: users[account.key].id, role: account.membership },
    });
  }

  const project =
    (await prisma.project.findFirst({ where: { organisationId: organisation.id, slug: "checkout" }, select: { id: true } })) ??
    (await prisma.project.create({
      data: { organisationId: organisation.id, slug: "checkout", name: "Checkout", goal: "A small shop's checkout page." },
      select: { id: true },
    }));

  const title = "Checkout total ignores the discount code";
  const bug =
    (await prisma.bug.findFirst({ where: { organisationId: organisation.id, title }, select: { id: true, number: true } })) ??
    (await prisma.bug.create({
      data: {
        organisationId: organisation.id,
        projectId: project.id,
        title,
        description: "Applying a valid discount code at checkout leaves the order total unchanged.",
        reporterId: users.owner.id,
        assigneeId: users.fixer.id,
        beneficiaryUserId: users.fixer.id,
        status: "in_progress",
        substatus: "in_progress",
        reward: 5,
      },
      select: { id: true, number: true },
    }));

  console.log("\nZiki Coins accounts\n");
  for (const account of ACCOUNTS) console.log(`  ${account.key.padEnd(6)} ${account.email}`);
  console.log(`\n  password: ${PASSWORD}`);
  console.log(`\n  workspace: coins / project: checkout / issue #${bug.number}: ${title}`);
  console.log(`  issue id: ${bug.id}  (pnpm db:coins:go-live ${bug.id} resolves it and pays it out)\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
