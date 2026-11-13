import "server-only";
import Decimal from "decimal.js";
import { and, asc, eq, ne, sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { accounts } from "@/modules/ledger/schema";
import { customers, suppliers } from "@/modules/parties/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { ageOpenItems, type OpeningKind, type OpeningStatus, type PartyKind } from "./rules";
import { openingBalances, openingEntries } from "./schema";

export function requireOpeningAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "opening.read")) throw new UserError("Only an owner, an accountant or an auditor can see the opening balances.");
}

export type OpeningLine = {
  id: string;
  kind: OpeningKind;
  accountId: string | null;
  customerId: string | null;
  supplierId: string | null;
  /** The account's code and name, or the customer's or supplier's code and name. */
  code: string | null;
  name: string;
  documentNumber: string | null;
  documentDate: string | null;
  dueDate: string | null;
  debit: Decimal;
  credit: Decimal;
};

export type OpeningEntry = {
  id: string;
  status: OpeningStatus;
  openingDate: string;
  journalId: string | null;
  postedAt: Date | null;
  updatedAt: Date;
  lines: OpeningLine[];
};

/**
 * The company's opening entry that is not reversed (a draft or the posted one) with its lines,
 * inside a transaction the caller already holds. Account lines come first, by code; then
 * receivables and payables, by party and document date.
 */
export async function selectOpening(tx: Tx, tenantId: string, lock?: SQL): Promise<OpeningEntry | null> {
  const live = and(eq(openingEntries.tenantId, tenantId), ne(openingEntries.status, "reversed"));
  if (lock) {
    // Held first, then read: what is read below cannot change until the transaction ends.
    const held = await tx.execute(sql`select 1 from ${openingEntries} where ${live} ${lock}`);
    if (held.length === 0) return null;
  }
  const [entry] = await tx
    .select({ id: openingEntries.id, status: openingEntries.status, openingDate: openingEntries.openingDate, journalId: openingEntries.journalId, postedAt: openingEntries.postedAt, updatedAt: openingEntries.updatedAt })
    .from(openingEntries)
    .where(live);
  if (!entry) return null;
  const rows = await tx
    .select({
      id: openingBalances.id,
      kind: openingBalances.kind,
      accountId: openingBalances.accountId,
      customerId: openingBalances.customerId,
      supplierId: openingBalances.supplierId,
      code: sql<string | null>`coalesce(${accounts.code}, ${customers.code}, ${suppliers.code})`,
      name: sql<string>`coalesce(${accounts.name}, ${customers.name}, ${suppliers.name})`,
      documentNumber: openingBalances.documentNumber,
      documentDate: openingBalances.documentDate,
      dueDate: openingBalances.dueDate,
      debit: openingBalances.debit,
      credit: openingBalances.credit,
    })
    .from(openingBalances)
    .leftJoin(accounts, and(eq(accounts.tenantId, openingBalances.tenantId), eq(accounts.id, openingBalances.accountId)))
    .leftJoin(customers, and(eq(customers.tenantId, openingBalances.tenantId), eq(customers.id, openingBalances.customerId)))
    .leftJoin(suppliers, and(eq(suppliers.tenantId, openingBalances.tenantId), eq(suppliers.id, openingBalances.supplierId)))
    .where(and(eq(openingBalances.tenantId, tenantId), eq(openingBalances.openingEntryId, entry.id)))
    .orderBy(
      asc(openingBalances.kind),
      asc(sql`coalesce(${accounts.code}, lower(${customers.name}), lower(${suppliers.name}))`),
      asc(openingBalances.documentDate),
      asc(sql`lower(${openingBalances.documentNumber})`),
    );
  return {
    ...entry,
    status: entry.status as OpeningStatus,
    lines: rows.map((row) => ({ ...row, kind: row.kind as OpeningKind, debit: new Decimal(row.debit), credit: new Decimal(row.credit) })),
  };
}

/** The opening entry as it stands: a draft being built, or the one that was posted. Null when there is none. */
export async function getOpening(ctx: TenantContext): Promise<OpeningEntry | null> {
  requireOpeningAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectOpening(tx, ctx.tenantId));
}

/**
 * What customers owed (or suppliers were owed) at opening, by how old each invoice is on
 * `asOf`. Age runs from each invoice's own date.
 */
export function ageOpening(entry: OpeningEntry, kind: PartyKind, asOf: string) {
  return ageOpenItems(
    entry.lines
      .filter((line) => line.kind === kind && line.documentDate !== null)
      .map((line) => ({ partyId: (kind === "receivable" ? line.customerId : line.supplierId) ?? "", partyName: line.name, documentDate: line.documentDate ?? "", amount: kind === "receivable" ? line.debit : line.credit })),
    asOf,
  );
}
