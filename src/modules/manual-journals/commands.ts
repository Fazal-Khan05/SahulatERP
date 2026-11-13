import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { AMOUNT_SCALE } from "@/lib/money";
import { isIsoDate } from "@/modules/currencies/rules";
import { postJournal, reverseJournal } from "@/modules/ledger/posting";
import { checkJournalLines } from "@/modules/ledger/rules";
import { takeDocumentNumber } from "@/modules/numbering/commands";
import { can, seesBranch, type TenantContext } from "@/modules/tenant/rules";
import { branches } from "@/modules/tenant/schema";
import { accountProblem, selectManualJournal, type ManualJournal } from "./queries";
import { draftTotals, readDraft, type Draft, type RawDraft } from "./rules";
import { manualJournalLines, manualJournals } from "./schema";

function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "journal.manage")) throw new UserError("Only an owner or an accountant can write journals.");
}

const NOT_HERE = "That journal is not in this company.";

/** The journal, held for the rest of the transaction, or a refusal. */
async function lockJournal(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<ManualJournal> {
  if (!isUuid(id)) throw new UserError(NOT_HERE);
  const journal = await selectManualJournal(tx, ctx.tenantId, id, sql`for update`);
  if (!journal) throw new UserError(NOT_HERE);
  // A form opened before someone else's change must not act on what it no longer shows.
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== journal.updatedAt.toISOString()) {
    throw new UserError("Someone changed this journal after you opened it. Reload the page and try again.");
  }
  return journal;
}

async function requireBranch(tx: Tx, ctx: TenantContext, branchId: string | null): Promise<void> {
  if (branchId === null) {
    if (ctx.branchIds !== null) throw new UserError("Choose the branch the journal belongs to.");
    return;
  }
  if (!isUuid(branchId) || !seesBranch(ctx.branchIds, branchId)) throw new UserError("Choose one of your branches.");
  const [found] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, ctx.tenantId), eq(branches.id, branchId)));
  if (!found) throw new UserError("Choose one of your branches.");
}

const describe = (draft: Draft) => {
  const totals = draftTotals(draft.lines);
  return { date: draft.date, memo: draft.memo, lines: draft.lines.length, debit: totals.debit.toFixed(AMOUNT_SCALE), credit: totals.credit.toFixed(AMOUNT_SCALE) };
};
const describeStored = (journal: ManualJournal) => describe({ date: journal.date, memo: journal.memo, branchId: journal.branchId, lines: journal.lines });

async function writeLines(tx: Tx, ctx: TenantContext, id: string, draft: Draft): Promise<void> {
  await tx.delete(manualJournalLines).where(and(eq(manualJournalLines.tenantId, ctx.tenantId), eq(manualJournalLines.manualJournalId, id)));
  if (draft.lines.length === 0) return;
  await tx.insert(manualJournalLines).values(
    draft.lines.map((line, index) => ({
      tenantId: ctx.tenantId,
      manualJournalId: id,
      lineNo: index + 1,
      accountId: line.accountId,
      description: line.description,
      debit: line.debit.toFixed(AMOUNT_SCALE),
      credit: line.credit.toFixed(AMOUNT_SCALE),
      createdBy: ctx.userId,
    })),
  );
}

/**
 * Saves a manual journal as a draft: a new one, or an existing draft with its lines replaced.
 * A draft need not balance. Returns its id.
 */
export async function saveDraft(ctx: TenantContext, id: unknown, raw: RawDraft, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requireManager(ctx);
  const read = readDraft(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.draft;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    await requireBranch(tx, ctx, draft.branchId);
    const problem = await accountProblem(tx, ctx, draft);
    if (problem) throw new UserError(problem);
    if (id === null || id === undefined || id === "") {
      const [row] = await tx
        .insert(manualJournals)
        .values({ tenantId: ctx.tenantId, journalDate: draft.date, memo: draft.memo, branchId: draft.branchId, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning({ id: manualJournals.id, updatedAt: manualJournals.updatedAt });
      await writeLines(tx, ctx, row.id, draft);
      await audit(tx, ctx, { action: "manual_journal.create", entity: "manual_journal", entityId: row.id, after: describe(draft) });
      return row;
    }
    const journal = await lockJournal(tx, ctx, id, loadedAt);
    if (journal.status !== "draft") throw new UserError("This journal is posted and cannot be changed. Reverse it instead.");
    const [saved] = await tx
      .update(manualJournals)
      .set({ journalDate: draft.date, memo: draft.memo, branchId: draft.branchId, updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(and(eq(manualJournals.tenantId, ctx.tenantId), eq(manualJournals.id, journal.id)))
      .returning({ id: manualJournals.id, updatedAt: manualJournals.updatedAt });
    await writeLines(tx, ctx, journal.id, draft);
    await audit(tx, ctx, { action: "manual_journal.update", entity: "manual_journal", entityId: journal.id, before: describeStored(journal), after: describe(draft) });
    return saved;
  });
}

/** Throws a draft away. A posted journal is never removed. */
export async function discardDraft(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const journal = await lockJournal(tx, ctx, id, loadedAt);
    if (journal.status !== "draft") throw new UserError("This journal is posted and cannot be removed. Reverse it instead.");
    await tx.delete(manualJournalLines).where(and(eq(manualJournalLines.tenantId, ctx.tenantId), eq(manualJournalLines.manualJournalId, journal.id)));
    await tx.delete(manualJournals).where(and(eq(manualJournals.tenantId, ctx.tenantId), eq(manualJournals.id, journal.id)));
    await audit(tx, ctx, { action: "manual_journal.discard", entity: "manual_journal", entityId: journal.id, before: describeStored(journal), after: null });
  });
}

/**
 * Posts a draft: takes its number and posts its journal, in one transaction. The lines must
 * balance and the date must fall in a period that is open and not locked.
 */
export async function postManualJournal(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requireManager(ctx);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const journal = await lockJournal(tx, ctx, id, loadedAt);
      if (journal.status !== "draft") throw new UserError("This journal is already posted.");
      const draft: Draft = { date: journal.date, memo: journal.memo, branchId: journal.branchId, lines: journal.lines };
      const checked = checkJournalLines(draft.lines);
      if (!checked.ok) throw new UserError(checked.reason);
      await requireBranch(tx, ctx, draft.branchId);
      const problem = await accountProblem(tx, ctx, draft);
      if (problem) throw new UserError(problem);
      // The number is taken here, at posting, so a draft that is thrown away leaves no gap.
      const number = await takeDocumentNumber(tx, "JV", draft.date);
      const journalId = await postJournal(tx, { type: "manual_journal", id: journal.id, date: draft.date, documentNumber: number, memo: draft.memo, branchId: draft.branchId }, draft.lines);
      await tx
        .update(manualJournals)
        .set({ status: "posted", number, journalId, postedAt: sql`now()`, postedBy: ctx.userId, updatedAt: sql`now()`, updatedBy: ctx.userId })
        .where(and(eq(manualJournals.tenantId, ctx.tenantId), eq(manualJournals.id, journal.id)));
      await audit(tx, ctx, { action: "manual_journal.post", entity: "manual_journal", entityId: journal.id, after: { number, journalId, ...describe(draft) } });
      return { number };
    });
  } catch (error) {
    if (pgCode(error) === "SE041" || pgCode(error) === "SE043") throw new UserError("This journal could not be posted as it stands. Open it again, save it, and post it once more.");
    throw error;
  }
}

/**
 * Reverses a posted manual journal on a date: a second journal with every debit and credit
 * swapped. The manual journal is then marked reversed; both journals stay in the books.
 */
export async function reverseManualJournal(ctx: TenantContext, id: unknown, raw: { date?: unknown }, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  const date = raw.date;
  if (!isIsoDate(date)) throw new UserError("Enter the date of the reversal.");
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const journal = await lockJournal(tx, ctx, id, loadedAt);
    if (journal.status === "draft") throw new UserError("This journal is a draft. It can be changed or thrown away; only a posted journal is reversed.");
    if (journal.status === "reversed" || journal.journalId === null) throw new UserError("This journal has already been reversed.");
    if (date < journal.date) throw new UserError("A reversal is dated on or after the journal it reverses.");
    const reversalJournalId = await reverseJournal(tx, journal.journalId, { date, memo: `Reversal of ${journal.number}: ${journal.memo}`.slice(0, 500) });
    await tx
      .update(manualJournals)
      .set({ status: "reversed", reversalJournalId, reversedAt: sql`now()`, reversedBy: ctx.userId, updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(and(eq(manualJournals.tenantId, ctx.tenantId), eq(manualJournals.id, journal.id)));
    await audit(tx, ctx, { action: "manual_journal.reverse", entity: "manual_journal", entityId: journal.id, before: { number: journal.number, status: "posted" }, after: { number: journal.number, status: "reversed", date, reversalJournalId } });
  });
}
