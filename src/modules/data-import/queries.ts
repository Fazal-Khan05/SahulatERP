import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getPurchaseReport } from "@/modules/purchase-reports/queries";
import { getTrialBalance, getYearStart } from "@/modules/reports/queries";
import type { ReportTable } from "@/modules/reports/rules";
import { getStockReport } from "@/modules/stock-reports/queries";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { isDataImportKind, type DataImportKind } from "./rules";

// Step 49: what has been brought in so far, and whether what came in agrees with the books.

function requireImporter(ctx: TenantContext): void {
  if (!can(ctx.role, "opening.manage")) throw new UserError("Only an owner or an accountant can import a company's data.");
}

export type ImportRecord = { id: string; kind: DataImportKind; fileName: string; rows: number; on: string; by: string | null };

export type ImportState = {
  counts: { customers: number; suppliers: number; items: number };
  /** Opening stock, in drafts still to post and posted. */
  stock: { drafts: number; posted: number; lines: number };
  /** The opening entry: none, a draft, or posted; with its date and how many lines of each kind. */
  opening: { status: "none" | "draft" | "posted"; date: string | null; receivable: number; payable: number; account: number };
  history: ImportRecord[];
};

/** What the company has now, and every file imported under Settings, Import data, newest first. */
export async function getImportState(ctx: TenantContext): Promise<ImportState> {
  requireImporter(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [counts] = await tx.execute<{ customers: number; suppliers: number; items: number; drafts: number; posted: number; lines: number }>(sql`
      select
        (select count(*)::int from public.customers where tenant_id = ${ctx.tenantId}) as customers,
        (select count(*)::int from public.suppliers where tenant_id = ${ctx.tenantId}) as suppliers,
        (select count(*)::int from public.items where tenant_id = ${ctx.tenantId}) as items,
        (select count(*)::int from public.stock_adjustments where tenant_id = ${ctx.tenantId} and kind = 'opening' and status = 'draft') as drafts,
        (select count(*)::int from public.stock_adjustments where tenant_id = ${ctx.tenantId} and kind = 'opening' and status = 'posted') as posted,
        (select count(*)::int from public.stock_adjustment_lines l join public.stock_adjustments a on a.tenant_id = l.tenant_id and a.id = l.adjustment_id
          where l.tenant_id = ${ctx.tenantId} and a.kind = 'opening') as lines`);
    // The entry in use: a draft, else the posted one (a reversed entry is followed by a new draft).
    const [entry] = await tx.execute<{ status: "draft" | "posted"; opening_date: string; receivable: number; payable: number; account: number }>(sql`
      select e.status, e.opening_date::text,
        count(*) filter (where b.kind = 'receivable')::int as receivable,
        count(*) filter (where b.kind = 'payable')::int as payable,
        count(*) filter (where b.kind = 'account')::int as account
      from public.opening_entries e
      left join public.opening_balances b on b.tenant_id = e.tenant_id and b.opening_entry_id = e.id
      where e.tenant_id = ${ctx.tenantId} and e.status in ('draft', 'posted')
      group by e.id, e.status, e.opening_date
      order by (e.status = 'draft') desc, e.created_at desc
      limit 1`);
    const history = await tx.execute<{ id: string; kind: string; file_name: string; rows: number; created_at: Date; email: string | null }>(sql`
      select d.id, d.kind, d.file_name, d.rows, d.created_at, m.email
      from public.data_imports d
      left join public.memberships m on m.tenant_id = d.tenant_id and m.user_id = d.created_by
      where d.tenant_id = ${ctx.tenantId}
      order by d.created_at desc
      limit 50`);
    return {
      counts: { customers: counts.customers, suppliers: counts.suppliers, items: counts.items },
      stock: { drafts: counts.drafts, posted: counts.posted, lines: counts.lines },
      opening: entry
        ? { status: entry.status, date: entry.opening_date, receivable: entry.receivable, payable: entry.payable, account: entry.account }
        : { status: "none", date: null, receivable: 0, payable: 0, account: 0 },
      history: history.flatMap((row) =>
        isDataImportKind(row.kind)
          ? [{ id: row.id, kind: row.kind, fileName: row.file_name, rows: row.rows, on: formatIsoDate(todayIso(new Date(row.created_at))), by: row.email }]
          : [],
      ),
    };
  });
}

/** One part of the books held twice: in its own records, and in its account in the books. */
export type Agreement = {
  what: "stock" | "receivables" | "payables";
  title: string;
  /** What the records add up to, what the account in the books stands at, and the difference. */
  records: Decimal;
  books: Decimal;
  difference: Decimal;
  /** Where to see it in full. */
  href: string;
};

export type OpeningCheck = {
  asAt: string;
  trialBalance: ReportTable;
  agreements: Agreement[];
  /** What is still to do before the figures are all in the books. */
  waiting: string[];
};

const textOf = (cell: unknown) => (typeof cell === "string" ? cell : "");
/** The last figure of the report's row whose first words are `label`, or null. */
function figure(table: ReportTable, label: string): Decimal | null {
  const row = table.rows.find((candidate) => candidate.cells.some((cell) => textOf(cell) === label));
  const last = row ? [...row.cells].reverse().find((cell) => cell instanceof Decimal) : undefined;
  return last instanceof Decimal ? last : null;
}

/**
 * The trial balance as at a day, and whether stock, what customers owe and what is owed to
 * suppliers agree with their accounts in the books. Stock and payables are worked out by their
 * own reports (Stock valuation, Aged payables), which set them against the books already; what
 * customers owe is the open invoices the ageing works from, against Trade receivables.
 */
export async function getOpeningCheck(ctx: TenantContext, asAt: string, state: ImportState): Promise<OpeningCheck> {
  requireImporter(ctx);
  const yearStart = await getYearStart(ctx, asAt);
  const trialBalance = await getTrialBalance(ctx, { from: yearStart, to: asAt, branchId: null, accountId: null });
  const agreements: Agreement[] = [];

  if (can(ctx.role, "stock.cost.read")) {
    const stock = await getStockReport(ctx, "valuation", { from: asAt, to: asAt, branchId: null, warehouseId: null, itemId: null }, asAt);
    const records = figure(stock, "Total");
    const books = figure(stock, "Stock account in the books");
    if (records && books) agreements.push({ what: "stock", title: "Stock", records, books, difference: records.minus(books), href: `/stock-reports/valuation?to=${asAt}` });
  }
  const [receivables] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ records: string; books: string }>(sql`
      select
        (select coalesce(sum(r.outstanding), 0) from app.receivables_open_all() r)::text as records,
        (select coalesce(sum(l.debit - l.credit), 0)
          from public.journal_lines l
          join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
          join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
          where l.tenant_id = ${ctx.tenantId} and a.control_type = 'ar' and j.journal_date <= ${asAt}::date)::text as books`),
  );
  const owed = new Decimal(receivables.records);
  const held = new Decimal(receivables.books);
  agreements.push({ what: "receivables", title: "What customers owe", records: owed, books: held, difference: owed.minus(held), href: "/recovery/ageing" });
  if (can(ctx.role, "supplier_bill.read")) {
    const payables = await getPurchaseReport(ctx, "aged-payables", { from: asAt, to: asAt, branchId: null, supplierId: null });
    const records = figure(payables, "Total");
    const books = figure(payables, "Trade payables less advances to suppliers, in the books");
    if (records && books) agreements.push({ what: "payables", title: "What is owed to suppliers", records, books, difference: records.minus(books), href: `/purchase-reports/aged-payables?to=${asAt}` });
  }

  const waiting: string[] = [];
  if (state.opening.status === "none") waiting.push("No opening entry has been started. Start it under Settings, Opening balances: it sets the day the books open here.");
  if (state.opening.status === "draft") waiting.push("The opening balances are a draft: nothing on them is in the books yet. Post them under Settings, Opening balances.");
  if (state.stock.drafts > 0) waiting.push(`${state.stock.drafts === 1 ? "One opening stock draft is" : `${state.stock.drafts} opening stock drafts are`} not posted yet: the stock is not in the books until ${state.stock.drafts === 1 ? "it is" : "they are"}. Post them under Stock, Adjustments.`);
  return { asAt, trialBalance, agreements, waiting };
}
