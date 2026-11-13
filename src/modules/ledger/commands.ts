import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { isAccountTemplate } from "@/modules/setup/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { selectAccounts } from "./queries";
import { chartOrder, codeCeiling, depthProblem, lockedReason, readAccountName, readCode, readNewAccount, suggestCode, type Account } from "./rules";
import { accounts } from "./schema";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const POSTINGS_KEY = "journal_lines_account_fk";

/** What the database's own rules for the tree say when a change breaks one (app.check_account). */
const TREE_REFUSALS: Record<string, string> = {
  SE031: "That is an account, not a heading. Choose a heading.",
  SE032: "That heading is archived. Restore it first, or choose another heading.",
  SE033: "That account cannot sit there.",
  SE034: "The chart of accounts can be at most five levels deep, and a heading four. Choose a heading higher up.",
  SE035: "Restore the account before changing it.",
  SE036: "Archive the accounts under this heading first.",
};

function treeRefusal(error: unknown): UserError | null {
  const message = TREE_REFUSALS[pgCode(error) ?? ""];
  return message ? new UserError(message) : null;
}

/** A form opened before someone else's change must not act on what it no longer shows. */
function refuseStale(account: Account, loadedAt: unknown): void {
  if (typeof loadedAt === "string" && loadedAt !== "" && loadedAt !== account.updatedAt.toISOString()) {
    throw new UserError("Someone changed this account after you opened it. Reload the page and try again.");
  }
}

function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "account.manage")) throw new UserError("Only an owner or an accountant can change the chart of accounts.");
}

/** The name of the constraint a failed statement broke, looking through Drizzle's wrapper. */
function constraintOf(error: unknown): string {
  const e = error as { constraint_name?: unknown; cause?: { constraint_name?: unknown } } | null;
  const name = e?.cause?.constraint_name ?? e?.constraint_name;
  return typeof name === "string" ? name : "";
}

function duplicate(error: unknown): UserError | null {
  if (pgCode(error) !== UNIQUE_VIOLATION) return null;
  return new UserError(constraintOf(error).includes("code") ? "Another account already has this code." : "Another account already has this name.");
}

/**
 * Gives the company its starting chart of accounts. Once, by the owner; a company that already
 * has accounts is left as it is. The chart itself lives in the database function
 * app.seed_accounts, which also writes the audit row.
 */
export async function seedAccounts(ctx: TenantContext, template: unknown): Promise<{ created: number }> {
  if (!can(ctx.role, "account.seed")) throw new UserError("Only the owner can create the chart of accounts.");
  if (!isAccountTemplate(template)) throw new UserError("Choose a chart of accounts to start from.");
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.execute<{ created: number }>(sql`select app.seed_accounts(${template}) as created`));
  return { created: Number(rows[0].created) };
}

/**
 * One of the company's own accounts, held for the rest of the transaction, or a refusal. A
 * locked account is refused here: the database lets nobody hold it for a change.
 */
async function lockAccount(tx: Tx, ctx: TenantContext, id: unknown): Promise<Account> {
  if (!isUuid(id)) throw new UserError("That account is not in this company.");
  const [seen] = await selectAccounts(tx, ctx.tenantId, eq(accounts.id, id));
  if (!seen) throw new UserError("That account is not in this company.");
  const locked = lockedReason(seen);
  if (locked) throw new UserError(locked);
  const [held] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, id))).for("update");
  if (!held) throw new UserError("That account is not in this company.");
  // Read again: it may have changed while this waited for the row.
  const [found] = await selectAccounts(tx, ctx.tenantId, eq(accounts.id, id));
  return found;
}

const summary = (account: Pick<Account, "code" | "name">) => ({ code: account.code, name: account.name });

/**
 * Adds an account, or a heading, under a heading. It takes its type from the heading, and
 * the next free code when none is typed.
 */
export async function addAccount(ctx: TenantContext, raw: { parentId?: unknown; name?: unknown; code?: unknown; kind?: unknown }): Promise<{ id: string; code: string }> {
  requireManager(ctx);
  const read = readNewAccount(raw);
  if (!read.ok) throw new UserError(read.reason);
  const wanted = read.account;
  if (!isUuid(wanted.parentId)) throw new UserError("Choose the heading the account sits under.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const all = await selectAccounts(tx, ctx.tenantId);
      const parent = all.find((account) => account.id === wanted.parentId);
      if (!parent) throw new UserError("Choose the heading the account sits under.");
      if (!parent.isGroup) throw new UserError(`${parent.name} is an account, not a heading. Choose a heading.`);
      if (parent.archivedAt !== null) throw new UserError(`${parent.name} is archived. Restore it first, or choose another heading.`);
      const deep = depthProblem(chartOrder(all).find((account) => account.id === parent.id)?.depth ?? 0, wanted.isGroup);
      if (deep) throw new UserError(deep);
      const sameName = all.find((account) => account.name.toLowerCase() === wanted.name.toLowerCase());
      if (sameName) throw new UserError(sameName.archivedAt !== null ? `An archived account, ${sameName.code}, already has this name. Restore it instead.` : "Another account already has this name.");
      const code =
        wanted.code ??
        suggestCode(
          parent.code,
          all.filter((account) => account.parentId === parent.id).map((account) => account.code),
          all.map((account) => account.code),
          codeCeiling(parent, all),
        );
      if (code === null) throw new UserError("Enter a code for the account: there is no next free number under this heading.");
      const [row] = await tx
        .insert(accounts)
        .values({
          tenantId: ctx.tenantId,
          parentId: parent.id,
          code,
          name: wanted.name,
          type: parent.type,
          isGroup: wanted.isGroup,
          // The company's own accounts under the bank or cash heading are bank or cash accounts.
          controlType: parent.controlType === "bank" || parent.controlType === "cash" ? parent.controlType : null,
          createdBy: ctx.userId,
        })
        .returning({ id: accounts.id });
      await audit(tx, ctx, { action: "account.create", entity: "account", entityId: row.id, after: { code, name: wanted.name, under: parent.code, type: parent.type, heading: wanted.isGroup } });
      return { id: row.id, code };
    });
  } catch (error) {
    const refused = duplicate(error) ?? treeRefusal(error);
    if (refused) throw refused;
    // The heading was deleted between reading it and adding under it.
    if (pgCode(error) === FOREIGN_KEY_VIOLATION) throw new UserError("Choose the heading the account sits under.");
    throw error;
  }
}

/** Renames an account or changes its code. A locked account cannot be changed. */
export async function updateAccount(ctx: TenantContext, id: unknown, raw: { name?: unknown; code?: unknown }, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  const name = readAccountName(raw.name);
  if (!name.ok) throw new UserError(name.reason);
  const code = readCode(raw.code);
  if (!code.ok) throw new UserError(code.reason);
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const account = await lockAccount(tx, ctx, id);
      if (account.archivedAt !== null) throw new UserError("Restore the account before changing it.");
      refuseStale(account, loadedAt);
      if (account.name === name.name && account.code === code.code) return;
      await tx.update(accounts).set({ name: name.name, code: code.code, updatedAt: sql`now()` }).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, account.id)));
      await audit(tx, ctx, { action: "account.update", entity: "account", entityId: account.id, before: summary(account), after: { code: code.code, name: name.name } });
    });
  } catch (error) {
    const refused = duplicate(error) ?? treeRefusal(error);
    if (refused) throw refused;
    throw error;
  }
}

/**
 * Archives an account so it is no longer offered, or restores it. What was posted to it stays.
 * A heading can be archived only when everything under it is archived.
 */
export async function setAccountArchived(ctx: TenantContext, id: unknown, archived: boolean, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const account = await lockAccount(tx, ctx, id);
    refuseStale(account, loadedAt);
    if ((account.archivedAt !== null) === archived) return;
    if (archived && account.isGroup) {
      const live = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.parentId, account.id), isNull(accounts.archivedAt))).limit(1);
      if (live.length > 0) throw new UserError("Archive the accounts under this heading first.");
    }
    if (!archived && account.parentId !== null) {
      // Held until this transaction ends, so the heading cannot be archived in the same moment.
      const [parent] = await tx.select({ name: accounts.name, archivedAt: accounts.archivedAt }).from(accounts).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, account.parentId))).for("share");
      if (parent && parent.archivedAt !== null) throw new UserError(`Restore the heading ${parent.name} first.`);
    }
    await tx
      .update(accounts)
      .set({ archivedAt: archived ? sql`now()` : null, archivedBy: archived ? ctx.userId : null, updatedAt: sql`now()` })
      .where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, account.id)));
    await audit(tx, ctx, {
      action: archived ? "account.archive" : "account.restore",
      entity: "account",
      entityId: account.id,
      before: { ...summary(account), archived: !archived },
      after: { ...summary(account), archived },
    });
  });
}

/**
 * Deletes an account nothing uses. One with postings, or a heading with accounts under it, is
 * refused by the database: it can only be archived.
 */
export async function deleteAccount(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const account = await lockAccount(tx, ctx, id);
      refuseStale(account, loadedAt);
      await tx.delete(accounts).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, account.id)));
      await audit(tx, ctx, { action: "account.delete", entity: "account", entityId: account.id, before: { ...summary(account), type: account.type, heading: account.isGroup }, after: null });
    });
  } catch (error) {
    if (pgCode(error) === FOREIGN_KEY_VIOLATION) {
      const broken = constraintOf(error);
      if (broken === "accounts_parent_fk") throw new UserError("This heading has accounts under it, so it cannot be deleted. Delete them first, or archive the heading.");
      if (broken === POSTINGS_KEY) throw new UserError("This account has postings, so it cannot be deleted. Archive it instead: it stays in the books but is no longer offered.");
      throw new UserError("This account is in use, so it cannot be deleted. Archive it instead.");
    }
    throw error;
  }
}
