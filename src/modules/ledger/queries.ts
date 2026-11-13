import "server-only";
import Decimal from "decimal.js";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { chartOrder, type Account, type AccountNode, type AccountType } from "./rules";
import { accounts, journalLines, journals } from "./schema";

export function requireAccountAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "account.read")) throw new UserError("Only an owner, an accountant or an auditor can see the chart of accounts.");
}

/** Accounts of the company, inside a transaction the caller already holds. */
export async function selectAccounts(tx: Tx, tenantId: string, where?: SQL): Promise<Account[]> {
  const rows = await tx
    .select({
      id: accounts.id,
      parentId: accounts.parentId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      isGroup: accounts.isGroup,
      isControl: accounts.isControl,
      controlType: accounts.controlType,
      archivedAt: accounts.archivedAt,
      updatedAt: accounts.updatedAt,
    })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), where));
  return rows.map((row) => ({ ...row, type: row.type as AccountType }));
}

/** The whole chart in reading order, archived accounts included. */
export async function listAccounts(ctx: TenantContext): Promise<AccountNode[]> {
  requireAccountAccess(ctx);
  return chartOrder(await withTenant(ctx.userId, ctx.tenantId, (tx) => selectAccounts(tx, ctx.tenantId)));
}

/** One account, or null when it is not this company's. */
export async function getAccount(ctx: TenantContext, id: string): Promise<Account | null> {
  requireAccountAccess(ctx);
  if (!isUuid(id)) return null;
  const [found] = await withTenant(ctx.userId, ctx.tenantId, (tx) => selectAccounts(tx, ctx.tenantId, eq(accounts.id, id)));
  return found ?? null;
}

/** Whether the company has a chart of accounts yet. Asked by the setup wizard, for the owner. */
export async function hasAccounts(ctx: TenantContext): Promise<boolean> {
  requireAccountAccess(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) => tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.tenantId, ctx.tenantId)).limit(1));
  return rows.length > 0;
}

export type JournalLineRow = {
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: Decimal;
  credit: Decimal;
  description: string | null;
  customerId: string | null;
  supplierId: string | null;
};

export type Journal = {
  id: string;
  date: string;
  sourceType: string;
  sourceId: string;
  documentNumber: string | null;
  memo: string | null;
  branchId: string | null;
  /** Set on a reversal: the journal it undoes. */
  reversesJournalId: string | null;
  /** Set once the journal has been reversed: its reversal. */
  reversedByJournalId: string | null;
  createdAt: Date;
  createdBy: string;
  lines: JournalLineRow[];
};

/** One posted journal with its lines in order, inside a transaction the caller already holds. */
export async function selectJournal(tx: Tx, tenantId: string, id: string): Promise<Journal | null> {
  const reversal = alias(journals, "reversal");
  const [row] = await tx
    .select({
      id: journals.id,
      date: journals.journalDate,
      sourceType: journals.sourceType,
      sourceId: journals.sourceId,
      documentNumber: journals.documentNumber,
      memo: journals.memo,
      branchId: journals.branchId,
      reversesJournalId: journals.reversesJournalId,
      reversedByJournalId: reversal.id,
      createdAt: journals.createdAt,
      createdBy: journals.createdBy,
    })
    .from(journals)
    .leftJoin(reversal, and(eq(reversal.tenantId, journals.tenantId), eq(reversal.reversesJournalId, journals.id)))
    .where(and(eq(journals.tenantId, tenantId), eq(journals.id, id)));
  if (!row) return null;
  const lines = await tx
    .select({
      lineNo: journalLines.lineNo,
      accountId: journalLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      debit: journalLines.debit,
      credit: journalLines.credit,
      description: journalLines.description,
      customerId: journalLines.customerId,
      supplierId: journalLines.supplierId,
    })
    .from(journalLines)
    .innerJoin(accounts, and(eq(accounts.tenantId, journalLines.tenantId), eq(accounts.id, journalLines.accountId)))
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.journalId, id)))
    .orderBy(asc(journalLines.lineNo));
  return { ...row, lines: lines.map((line) => ({ ...line, debit: new Decimal(line.debit), credit: new Decimal(line.credit) })) };
}

/**
 * One posted journal with its lines, or null when it is not this company's or belongs to a
 * branch outside this member's branches.
 */
export async function getJournal(ctx: TenantContext, id: string): Promise<Journal | null> {
  requireAccountAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectJournal(tx, ctx.tenantId, id));
}

/**
 * The journal a document posted, found by the document: for the "in the books" part of a
 * document's own page. Null when it posted none, or when the reader does not read the ledger.
 */
export async function getDocumentJournal(ctx: TenantContext, sourceType: string, sourceId: string): Promise<Journal | null> {
  if (!can(ctx.role, "account.read") || !isUuid(sourceId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [found] = await tx.select({ id: journals.id }).from(journals).where(and(eq(journals.tenantId, ctx.tenantId), eq(journals.sourceType, sourceType), eq(journals.sourceId, sourceId)));
    return found ? selectJournal(tx, ctx.tenantId, found.id) : null;
  });
}
