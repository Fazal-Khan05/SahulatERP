import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { AMOUNT_SCALE } from "@/lib/money";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { postJournal, reverseJournal } from "@/modules/ledger/posting";
import { selectAccounts } from "@/modules/ledger/queries";
import { MAX_JOURNAL_LINES, type Account } from "@/modules/ledger/rules";
import { accounts } from "@/modules/ledger/schema";
import { customers, suppliers } from "@/modules/parties/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { selectOpening, type OpeningEntry } from "./queries";
import {
  KIND_WORDS,
  MAX_OPENING_LINES,
  accountLineRefusal,
  openingJournal,
  readAccountImport,
  readAmounts,
  readDocument,
  readPartyImport,
  type AccountLine,
  type ImportProblem,
  type PartyKind,
  type PartyLine,
  type StoredLine,
} from "./rules";
import { openingBalances, openingEntries } from "./schema";

const UNIQUE_VIOLATION = "23505";

function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "opening.manage")) throw new UserError("Only an owner or an accountant can enter opening balances.");
  // The opening journal belongs to the whole company.
  if (ctx.branchIds !== null) throw new UserError("Opening balances belong to the whole company. Someone who works in every branch must enter them.");
}

const NONE = "There is no opening entry yet. Start one first.";
const EARLIER_JOURNALS = (openingDate: string) =>
  `The books already hold journals dated before ${openingDate.split("-").reverse().join("-")}. Opening balances are dated on or before the first entry in the books: choose an earlier opening date, or reverse those journals.`;
const POSTED = "The opening balances are posted and cannot be changed. Reverse them to correct them.";

/** The draft, held for the rest of the transaction, or a refusal. Every change marks the entry as changed. */
async function lockDraft(tx: Tx, ctx: TenantContext, loadedAt?: unknown): Promise<OpeningEntry> {
  const entry = await selectOpening(tx, ctx.tenantId, sql`for update`);
  if (!entry) throw new UserError(NONE);
  if (entry.status !== "draft") throw new UserError(POSTED);
  refuseStale(entry, loadedAt);
  return entry;
}

/** A form opened before someone else's change must not act on what it no longer shows. */
function refuseStale(entry: OpeningEntry, loadedAt: unknown): void {
  if (typeof loadedAt === "string" && loadedAt !== "" && loadedAt !== entry.updatedAt.toISOString()) {
    throw new UserError("The opening balances were changed after you opened this page. Reload the page and try again.");
  }
}

async function touch(tx: Tx, ctx: TenantContext, entryId: string): Promise<void> {
  await tx.update(openingEntries).set({ updatedAt: sql`now()`, updatedBy: ctx.userId }).where(and(eq(openingEntries.tenantId, ctx.tenantId), eq(openingEntries.id, entryId)));
}

const fixed = (amount: { toFixed(scale: number): string }) => amount.toFixed(AMOUNT_SCALE);

/**
 * Starts the opening entry: a draft dated on the first day the books are kept here. A company
 * has one at a time.
 */
export async function startOpening(ctx: TenantContext, raw: { date?: unknown }): Promise<{ id: string }> {
  requireManager(ctx);
  const date = raw.date;
  if (!isIsoDate(date)) throw new UserError("Enter the opening date.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx.insert(openingEntries).values({ tenantId: ctx.tenantId, openingDate: date, createdBy: ctx.userId, updatedBy: ctx.userId }).returning({ id: openingEntries.id });
      await audit(tx, ctx, { action: "opening.start", entity: "opening_entry", entityId: row.id, after: { openingDate: date } });
      return { id: row.id };
    });
  } catch (error) {
    if (pgCode(error) !== UNIQUE_VIOLATION) throw error;
    const existing = await withTenant(ctx.userId, ctx.tenantId, (tx) => selectOpening(tx, ctx.tenantId));
    throw new UserError(
      existing?.status === "posted"
        ? "This company's opening balances are already posted. Reverse them to correct them."
        : "This company already has opening balances in draft. Carry on with them, or discard them to start again.",
    );
  }
}

/** Changes the opening date of a draft. Every invoice and bill on it must still be dated before it. */
export async function setOpeningDate(ctx: TenantContext, raw: { date?: unknown }, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  const date = raw.date;
  if (!isIsoDate(date)) throw new UserError("Enter the opening date.");
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const entry = await lockDraft(tx, ctx, loadedAt);
    if (entry.openingDate === date) return;
    const late = entry.lines.find((line) => line.documentDate !== null && line.documentDate >= date);
    if (late) throw new UserError(`${late.name}'s ${late.kind === "payable" ? "bill" : "invoice"} ${late.documentNumber} is dated on or after that day. Remove it first, or choose a later opening date.`);
    await tx.update(openingEntries).set({ openingDate: date, updatedAt: sql`now()`, updatedBy: ctx.userId }).where(and(eq(openingEntries.tenantId, ctx.tenantId), eq(openingEntries.id, entry.id)));
    await audit(tx, ctx, { action: "opening.set_date", entity: "opening_entry", entityId: entry.id, before: { openingDate: entry.openingDate }, after: { openingDate: date } });
  });
}

/** Why this account cannot carry an opening balance of its own, or null when it can. */
function accountProblem(account: Account | undefined): string | null {
  if (!account) return "That account is not in this company.";
  const label = `${account.code} ${account.name}`;
  if (account.isGroup) return `${label} is a heading. Choose one of the accounts under it.`;
  if (account.archivedAt !== null) return `${label} is archived. Restore it, or choose another account.`;
  const refusal = accountLineRefusal(account.controlType);
  return refusal ? `${label} ${refusal}` : null;
}

async function insertAccountLines(tx: Tx, ctx: TenantContext, entryId: string, lines: readonly AccountLine[]): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(openingBalances).values(lines.map((line) => ({ tenantId: ctx.tenantId, openingEntryId: entryId, kind: "account", accountId: line.accountId, debit: fixed(line.debit), credit: fixed(line.credit), createdBy: ctx.userId })));
}

async function insertPartyLines(tx: Tx, ctx: TenantContext, entryId: string, kind: PartyKind, lines: readonly PartyLine[]): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(openingBalances).values(
    lines.map((line) => ({
      tenantId: ctx.tenantId,
      openingEntryId: entryId,
      kind,
      customerId: kind === "receivable" ? line.partyId : null,
      supplierId: kind === "payable" ? line.partyId : null,
      documentNumber: line.documentNumber,
      documentDate: line.documentDate,
      dueDate: line.dueDate,
      debit: kind === "receivable" ? fixed(line.amount) : "0",
      credit: kind === "payable" ? fixed(line.amount) : "0",
      createdBy: ctx.userId,
    })),
  );
}

function refuseTooMany(entry: OpeningEntry, adding: number): void {
  if (entry.lines.length + adding > MAX_OPENING_LINES) throw new UserError(`The opening entry can hold at most ${MAX_OPENING_LINES} lines.`);
}

/**
 * Sets what one account stood at. Saving the same account again corrects its balance; the
 * audit row keeps both.
 */
export async function setAccountBalance(ctx: TenantContext, raw: { accountId?: unknown; debit?: unknown; credit?: unknown }, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  const accountId = raw.accountId;
  if (!isUuid(accountId)) throw new UserError("Choose an account.");
  const amounts = readAmounts(raw);
  if (!amounts.ok) throw new UserError(amounts.reason);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const entry = await lockDraft(tx, ctx, loadedAt);
    const [account] = await selectAccounts(tx, ctx.tenantId, eq(accounts.id, accountId));
    const problem = accountProblem(account);
    if (problem) throw new UserError(problem);
    const existing = entry.lines.find((line) => line.kind === "account" && line.accountId === accountId);
    if (existing) await tx.delete(openingBalances).where(and(eq(openingBalances.tenantId, ctx.tenantId), eq(openingBalances.id, existing.id)));
    else refuseTooMany(entry, 1);
    await insertAccountLines(tx, ctx, entry.id, [{ accountId, debit: amounts.debit, credit: amounts.credit }]);
    await touch(tx, ctx, entry.id);
    await audit(tx, ctx, {
      action: "opening.set_account",
      entity: "opening_entry",
      entityId: entry.id,
      before: existing ? { account: account.code, debit: fixed(existing.debit), credit: fixed(existing.credit) } : null,
      after: { account: account.code, debit: fixed(amounts.debit), credit: fixed(amounts.credit) },
    });
  });
}

/**
 * Adds one unpaid invoice of a customer, or one unpaid bill of a supplier. The customer or
 * supplier is given by its code or its exact name; where one's code is another's name, the
 * code wins.
 */
export async function addOpenDocument(
  ctx: TenantContext,
  kind: PartyKind,
  raw: { party?: unknown; documentNumber?: unknown; documentDate?: unknown; dueDate?: unknown; amount?: unknown },
  loadedAt?: unknown,
): Promise<void> {
  requireManager(ctx);
  const words = KIND_WORDS[kind];
  const typed = cleanText(raw.party).toLowerCase();
  if (typed === "") throw new UserError(`Enter the ${words.party}'s code or name.`);
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const entry = await lockDraft(tx, ctx, loadedAt);
      const read = readDocument(raw, kind, entry.openingDate);
      if (!read.ok) throw new UserError(read.reason);
      const table = kind === "receivable" ? customers : suppliers;
      const found = await tx
        .select({ id: table.id, code: table.code, name: table.name })
        .from(table)
        .where(and(eq(table.tenantId, ctx.tenantId), sql`(lower(${table.code}) = ${typed} or lower(${table.name}) = ${typed})`));
      const party = found.find((candidate) => (candidate.code ?? "").toLowerCase() === typed) ?? found[0];
      if (!party) throw new UserError(`No ${words.party} has that code or name. Add the ${words.party} first, or type it exactly.`);
      refuseTooMany(entry, 1);
      await insertPartyLines(tx, ctx, entry.id, kind, [{ partyId: party.id, ...read.document }]);
      await touch(tx, ctx, entry.id);
      await audit(tx, ctx, {
        action: `opening.add_${kind}`,
        entity: "opening_entry",
        entityId: entry.id,
        after: { [words.party]: party.name, number: read.document.documentNumber, date: read.document.documentDate, dueDate: read.document.dueDate, amount: fixed(read.document.amount) },
      });
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError(`This ${words.party} already has ${words.document === "invoice" ? "an invoice" : "a bill"} with that number here.`);
    throw error;
  }
}

/** Removes one line from the draft. */
export async function removeOpeningLine(ctx: TenantContext, lineId: unknown, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const entry = await lockDraft(tx, ctx, loadedAt);
    const line = entry.lines.find((candidate) => candidate.id === lineId);
    // Removed already, or the entry was reversed and started again since the page was opened.
    if (!line) throw new UserError("That line is no longer on the opening entry. Reload the page.");
    await tx.delete(openingBalances).where(and(eq(openingBalances.tenantId, ctx.tenantId), eq(openingBalances.id, line.id)));
    await touch(tx, ctx, entry.id);
    await audit(tx, ctx, {
      action: "opening.remove_line",
      entity: "opening_entry",
      entityId: entry.id,
      before: { kind: line.kind, name: line.name, number: line.documentNumber, debit: fixed(line.debit), credit: fixed(line.credit) },
      after: null,
    });
  });
}

export type OpeningImportOutcome = { imported: number } | { problems: ImportProblem[] };

/**
 * Imports a CSV file into the draft, all or nothing: a trial balance (`account`), unpaid
 * customer invoices (`receivable`) or unpaid supplier bills (`payable`). If any row is wrong,
 * or names something already on the draft, no row is kept and every bad row is returned.
 */
export async function importOpeningLines(ctx: TenantContext, kind: "account" | PartyKind, file: { name: string; text: string }, loadedAt?: unknown): Promise<OpeningImportOutcome> {
  requireManager(ctx);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx): Promise<OpeningImportOutcome> => {
      const entry = await lockDraft(tx, ctx, loadedAt);
      let imported: number;
      if (kind === "account") {
        const chart = await selectAccounts(tx, ctx.tenantId);
        const known = (key: (account: Account) => string) => new Map(chart.map((account) => [key(account), { id: account.id, code: account.code, name: account.name, refusal: accountProblem(account)?.replace(`${account.code} ${account.name} `, "") ?? null }]));
        const read = readAccountImport(file.text, { byCode: known((account) => account.code), byName: known((account) => account.name.toLowerCase()) });
        if (read.status === "unreadable") throw new UserError(read.reason);
        const problems = [...read.problems];
        const have = new Set(entry.lines.filter((line) => line.kind === "account").map((line) => line.accountId));
        for (const { row, line } of read.lines) {
          const account = chart.find((candidate) => candidate.id === line.accountId);
          if (have.has(line.accountId)) problems.push({ row, name: account ? `${account.code} ${account.name}` : "", problems: ["This account already has an opening balance here. Remove that line first, or leave this row out."] });
        }
        if (problems.length > 0) return { problems: problems.sort((a, b) => a.row - b.row) };
        refuseTooMany(entry, read.lines.length);
        await insertAccountLines(tx, ctx, entry.id, read.lines.map(({ line }) => line));
        imported = read.lines.length;
      } else {
        const words = KIND_WORDS[kind];
        const table = kind === "receivable" ? customers : suppliers;
        const parties = await tx.select({ id: table.id, code: table.code, name: table.name }).from(table).where(eq(table.tenantId, ctx.tenantId));
        const read = readPartyImport(file.text, kind, entry.openingDate, {
          byCode: new Map(parties.filter((party) => party.code !== null).map((party) => [(party.code ?? "").toLowerCase(), party.id])),
          byName: new Map(parties.map((party) => [party.name.toLowerCase(), party.id])),
        });
        if (read.status === "unreadable") throw new UserError(read.reason);
        const problems = [...read.problems];
        const have = new Set(entry.lines.filter((line) => line.kind === kind).map((line) => `${kind === "receivable" ? line.customerId : line.supplierId} ${(line.documentNumber ?? "").toLowerCase()}`));
        for (const { row, line } of read.lines) {
          if (have.has(`${line.partyId} ${line.documentNumber.toLowerCase()}`)) {
            problems.push({ row, name: `${parties.find((party) => party.id === line.partyId)?.name ?? ""} ${line.documentNumber}`, problems: [`This ${words.document} of this ${words.party} is already here.`] });
          }
        }
        if (problems.length > 0) return { problems: problems.sort((a, b) => a.row - b.row) };
        refuseTooMany(entry, read.lines.length);
        await insertPartyLines(tx, ctx, entry.id, kind, read.lines.map(({ line }) => line));
        imported = read.lines.length;
      }
      await touch(tx, ctx, entry.id);
      await audit(tx, ctx, { action: `opening.import_${kind}`, entity: "opening_entry", entityId: entry.id, after: { rows: imported, file: file.name.replace(/[^\P{Cc}]/gu, "").slice(0, 120) } });
      return { imported };
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError("A row in the file is already on the opening entry. Nothing was imported; import the file again to see which row.");
    throw error;
  }
}

/** Throws the draft away, lines and all. Posted opening balances are reversed, never removed. */
export async function discardOpening(ctx: TenantContext, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const entry = await lockDraft(tx, ctx, loadedAt);
    await tx.delete(openingBalances).where(and(eq(openingBalances.tenantId, ctx.tenantId), eq(openingBalances.openingEntryId, entry.id)));
    await tx.delete(openingEntries).where(and(eq(openingEntries.tenantId, ctx.tenantId), eq(openingEntries.id, entry.id)));
    await audit(tx, ctx, { action: "opening.discard", entity: "opening_entry", entityId: entry.id, before: { openingDate: entry.openingDate, lines: entry.lines.length }, after: null });
  });
}

const toStored = (entry: OpeningEntry): StoredLine[] =>
  entry.lines.map((line) =>
    line.kind === "account"
      ? { kind: "account", accountId: line.accountId ?? "", debit: line.debit, credit: line.credit }
      : line.kind === "receivable"
        ? { kind: "receivable", customerId: line.customerId ?? "", amount: line.debit }
        : { kind: "payable", supplierId: line.supplierId ?? "", amount: line.credit },
  );

/**
 * Posts the opening balances: one journal on the opening date, with whatever the lines differ
 * by taken to opening balance equity. From then on the entry cannot be changed, only reversed.
 */
export async function postOpening(ctx: TenantContext, loadedAt?: unknown): Promise<{ difference: string }> {
  requireManager(ctx);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const entry = await lockDraft(tx, ctx, loadedAt);
      if (entry.lines.length === 0) throw new UserError("Add at least one balance before posting.");
      const controls = await selectAccounts(tx, ctx.tenantId, inArray(accounts.controlType, ["ar", "ap", "opening_equity"]));
      const control = (type: string) => controls.find((account) => account.isControl && !account.isGroup && account.controlType === type)?.id;
      const receivables = control("ar");
      const payables = control("ap");
      const openingEquity = control("opening_equity");
      if (!receivables || !payables || !openingEquity) throw new UserError("This company has no chart of accounts yet. Create it under Settings, Accounts.");
      // An account may have been archived, or turned out not to be allowed, since its line was added.
      const used = [...new Set(entry.lines.filter((line) => line.kind === "account").map((line) => line.accountId ?? ""))];
      const chart = used.length > 0 ? await selectAccounts(tx, ctx.tenantId, inArray(accounts.id, used)) : [];
      for (const id of used) {
        const problem = accountProblem(chart.find((account) => account.id === id));
        if (problem) throw new UserError(problem);
      }
      // What happened before the opening date is already inside these balances.
      const [earlier] = await tx.execute<{ source_type: string }>(sql`
        select j.source_type from public.journals j
        where j.tenant_id = ${ctx.tenantId} and j.journal_date < ${entry.openingDate}::date
          and j.source_type <> 'opening_balance'
          and not (j.source_type = 'reversal' and exists (
            select 1 from public.journals o where o.tenant_id = j.tenant_id and o.id = j.reverses_journal_id and o.source_type = 'opening_balance'))
        limit 1`);
      if (earlier) throw new UserError(EARLIER_JOURNALS(entry.openingDate));
      const journal = openingJournal(toStored(entry), { receivables, payables, openingEquity });
      if (journal.lines.length > MAX_JOURNAL_LINES) {
        throw new UserError(`These opening balances make a journal of ${journal.lines.length} lines, and a journal can hold ${MAX_JOURNAL_LINES}. That many customers and suppliers cannot be opened in one entry yet.`);
      }
      if (journal.lines.length < 2) throw new UserError("Add at least one balance above zero before posting.");
      const journalId = await postJournal(tx, { type: "opening_balance", id: entry.id, date: entry.openingDate, memo: "Opening balances" }, journal.lines);
      await tx
        .update(openingEntries)
        .set({ status: "posted", journalId, postedAt: sql`now()`, postedBy: ctx.userId, updatedAt: sql`now()`, updatedBy: ctx.userId })
        .where(and(eq(openingEntries.tenantId, ctx.tenantId), eq(openingEntries.id, entry.id)));
      const difference = fixed(journal.difference);
      await audit(tx, ctx, { action: "opening.post", entity: "opening_entry", entityId: entry.id, after: { openingDate: entry.openingDate, journalId, lines: entry.lines.length, journalLines: journal.lines.length, toOpeningEquity: difference } });
      return { difference };
    });
  } catch (error) {
    if (pgCode(error) === "SE041" || pgCode(error) === "SE043") throw new UserError("The opening balances could not be posted as they stand. Reload the page and try again.");
    throw error;
  }
}

/**
 * Reverses the posted opening balances and starts a new draft holding the same lines, so that
 * what was wrong can be corrected and posted again. The reversal is dated on the opening date
 * itself: dated any later, every day in between would show the opening balances twice once the
 * corrected ones are posted. Both journals stay in the books.
 */
export async function reverseOpening(ctx: TenantContext, loadedAt?: unknown): Promise<void> {
  requireManager(ctx);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const entry = await selectOpening(tx, ctx.tenantId, sql`for update`);
    // Reversed by someone else in the same moment: this page no longer shows what is there.
    if (!entry) throw new UserError("The opening balances were changed after you opened this page. Reload the page and try again.");
    refuseStale(entry, loadedAt);
    if (entry.status !== "posted" || entry.journalId === null) throw new UserError("The opening balances are still a draft. A draft is changed or thrown away; only posted balances are reversed.");
    const date = entry.openingDate;
    const reversalJournalId = await reverseJournal(tx, entry.journalId, { date, memo: "Reversal of the opening balances" });
    await tx
      .update(openingEntries)
      .set({ status: "reversed", reversalJournalId, reversedAt: sql`now()`, reversedBy: ctx.userId, updatedAt: sql`now()`, updatedBy: ctx.userId })
      .where(and(eq(openingEntries.tenantId, ctx.tenantId), eq(openingEntries.id, entry.id)));
    // The same lines again, as a draft to correct.
    const [draft] = await tx.insert(openingEntries).values({ tenantId: ctx.tenantId, openingDate: entry.openingDate, createdBy: ctx.userId, updatedBy: ctx.userId }).returning({ id: openingEntries.id });
    await tx.execute(sql`
      insert into ${openingBalances} (tenant_id, opening_entry_id, kind, account_id, customer_id, supplier_id, document_number, document_date, due_date, debit, credit, created_by)
      select tenant_id, ${draft.id}::uuid, kind, account_id, customer_id, supplier_id, document_number, document_date, due_date, debit, credit, ${ctx.userId}::uuid
      from ${openingBalances} where tenant_id = ${ctx.tenantId} and opening_entry_id = ${entry.id}`);
    await audit(tx, ctx, { action: "opening.reverse", entity: "opening_entry", entityId: entry.id, before: { status: "posted" }, after: { status: "reversed", date, reversalJournalId, newDraft: draft.id, lines: entry.lines.length } });
  });
}
