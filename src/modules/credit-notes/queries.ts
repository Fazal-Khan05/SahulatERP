import "server-only";
import Decimal from "decimal.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { selectOpenItems } from "@/modules/receipts/queries";
import type { OpenItem } from "@/modules/receipts/rules";
import type { SalesDocument } from "@/modules/sales/queries";
import type { SalesStatus } from "@/modules/sales/rules";
import { salesDocuments } from "@/modules/sales/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { creditLeft, stillToReturn, type InvoicedLine, type Returned } from "./rules";

export function requireCreditNoteAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "sales.read")) throw new UserError("Your role does not include sales documents.");
}

const exact = (value: string | null) => new Decimal(value ?? "0");

/** One line of an invoice with what posted credit notes have already taken back of it. */
export type ReturnableLine = InvoicedLine & {
  id: string;
  lineNo: number;
  itemCode: string;
  description: string;
  unitCode: string;
  returned: Returned;
  /** How much can still come back, in the unit the line was sold in. */
  left: Decimal;
};

type ReturnableRow = {
  id: string;
  line_no: number;
  item_code: string;
  description: string;
  unit_code: string;
  quantity: string;
  unit_factor: string;
  unit_price: string;
  value: string;
  tax_amount: string;
  further_tax_amount: string;
  extra_tax_amount: string;
  gone_quantity: string | null;
  gone_value: string | null;
  gone_tax: string | null;
  gone_further: string | null;
  gone_extra: string | null;
};

/**
 * The lines of one posted invoice, each with what posted credit notes have taken back of it,
 * inside a transaction the caller holds. A draft credit note takes nothing yet. Empty when the
 * invoice is not one this member may see.
 */
export async function selectReturnable(tx: Tx, tenantId: string, invoiceId: string): Promise<ReturnableLine[]> {
  const rows = await tx.execute<ReturnableRow>(sql`
    select o.id, o.line_no, i.code as item_code, o.description, u.code as unit_code,
           o.quantity::text, o.unit_factor::text, o.unit_price::text, o.value::text, o.tax_amount::text, o.further_tax_amount::text, o.extra_tax_amount::text,
           g.quantity::text as gone_quantity, g.value::text as gone_value, g.tax::text as gone_tax, g.further::text as gone_further, g.extra::text as gone_extra
    from sales_lines o
    join items i on i.tenant_id = o.tenant_id and i.id = o.item_id
    join units u on u.tenant_id = o.tenant_id and u.id = o.unit_id
    left join lateral (
      select sum(p.quantity) as quantity, sum(p.value) as value, sum(p.tax_amount) as tax, sum(p.further_tax_amount) as further, sum(p.extra_tax_amount) as extra
      from sales_lines p
      join sales_documents pd on pd.tenant_id = p.tenant_id and pd.id = p.document_id
      where p.tenant_id = o.tenant_id and p.source_line_id = o.id and pd.kind = 'credit_note' and pd.status = 'submitted'
    ) g on true
    where o.tenant_id = ${tenantId}::uuid and o.document_id = ${invoiceId}::uuid
    order by o.line_no`);
  return rows.map((row) => {
    const line = {
      quantity: exact(row.quantity),
      unitFactor: exact(row.unit_factor),
      unitPrice: exact(row.unit_price),
      value: exact(row.value),
      taxAmount: exact(row.tax_amount),
      furtherTaxAmount: exact(row.further_tax_amount),
      extraTaxAmount: exact(row.extra_tax_amount),
    };
    const returned = { quantity: exact(row.gone_quantity), value: exact(row.gone_value), taxAmount: exact(row.gone_tax), furtherTaxAmount: exact(row.gone_further), extraTaxAmount: exact(row.gone_extra) };
    return { ...line, id: row.id, lineNo: row.line_no, itemCode: row.item_code, description: row.description, unitCode: row.unit_code, returned, left: stillToReturn(line, returned) };
  });
}

/** The credit notes made from one invoice, drafts included, oldest first, inside a transaction the caller holds. */
export async function selectCreditNotesOf(tx: Tx, tenantId: string, invoiceId: string): Promise<{ id: string; number: string | null; status: SalesStatus; date: string; total: Decimal }[]> {
  const rows = await tx
    .select({ id: salesDocuments.id, number: salesDocuments.number, status: salesDocuments.status, date: salesDocuments.documentDate, total: salesDocuments.total })
    .from(salesDocuments)
    .where(and(eq(salesDocuments.tenantId, tenantId), eq(salesDocuments.kind, "credit_note"), eq(salesDocuments.sourceDocumentId, invoiceId)))
    .orderBy(asc(salesDocuments.createdAt));
  return rows.map((row) => ({ ...row, status: row.status as SalesStatus, total: new Decimal(row.total) }));
}

/** What one credit note has been set against: its own invoice when it was posted, and any invoice its credit went to later. */
export type SettledRow = { id: string; kind: "invoice" | "opening"; targetId: string; number: string | null; date: string | null; amount: Decimal; allocatedOn: string; later: boolean };

export async function selectSettled(tx: Tx, creditNoteId: string): Promise<SettledRow[]> {
  const rows = await tx.execute<{ id: string; kind: "invoice" | "opening"; target_id: string; number: string | null; document_date: string | null; amount: string; allocated_on: string; later: boolean }>(sql`
    select id, kind, target_id, number, document_date::text, amount::text, allocated_on::text, later
    from app.credit_note_settled(${creditNoteId}::uuid)`);
  return rows.map((row) => ({ id: row.id, kind: row.kind, targetId: row.target_id, number: row.number, date: row.document_date, amount: exact(row.amount), allocatedOn: row.allocated_on, later: row.later }));
}

/** What the page of an invoice says about its returns: what is left to return, and its credit notes. */
export async function getInvoiceReturns(ctx: TenantContext, invoice: Pick<SalesDocument, "id" | "kind" | "status">): Promise<{ lines: ReturnableLine[]; creditNotes: Awaited<ReturnType<typeof selectCreditNotesOf>> }> {
  requireCreditNoteAccess(ctx);
  if (invoice.kind !== "invoice" || invoice.status !== "submitted") return { lines: [], creditNotes: [] };
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => ({ lines: await selectReturnable(tx, ctx.tenantId, invoice.id), creditNotes: await selectCreditNotesOf(tx, ctx.tenantId, invoice.id) }));
}

/**
 * What the page of a credit note shows besides the document: for a draft, the invoice's lines
 * with what can still come back; for a posted one, what it was set against, the credit left,
 * and (for whoever may use that credit) the customer's unpaid invoices.
 */
export async function getCreditNoteFacts(
  ctx: TenantContext,
  creditNote: Pick<SalesDocument, "id" | "kind" | "status" | "customerId" | "source" | "totals">,
): Promise<{ returnable: ReturnableLine[]; settled: SettledRow[]; left: Decimal; open: OpenItem[] }> {
  requireCreditNoteAccess(ctx);
  if (creditNote.kind !== "credit_note" || !creditNote.source || !isUuid(creditNote.source.id)) return { returnable: [], settled: [], left: new Decimal(0), open: [] };
  const invoiceId = creditNote.source.id;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    if (creditNote.status === "draft") return { returnable: await selectReturnable(tx, ctx.tenantId, invoiceId), settled: [], left: new Decimal(0), open: [] };
    const settled = await selectSettled(tx, creditNote.id);
    const left = creditLeft(creditNote.totals.total, settled);
    const open = left.gt(0) && can(ctx.role, "credit_note.apply") ? await selectOpenItems(tx, creditNote.customerId) : [];
    return { returnable: [], settled, left, open };
  });
}
