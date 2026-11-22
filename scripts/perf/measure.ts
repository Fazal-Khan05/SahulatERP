import { writeFileSync } from "node:fs";
import { closeDb } from "@/db";
import { listPlans } from "@/modules/commissions/queries";
import { getEarned, listPayments as listCommissionPayments } from "@/modules/commission-ledger/queries";
import { getCommissionStatement, listStatements } from "@/modules/commission-statements/queries";
import { listItemChoices, listStockAdjustments, listStockCounts, listStockOnHand, listStockTransfers } from "@/modules/inventory/queries";
import { listItems } from "@/modules/items/queries";
import { listManualJournals } from "@/modules/manual-journals/queries";
import { listParties } from "@/modules/parties/queries";
import { listEmployees } from "@/modules/payroll/queries";
import { listPriceLists } from "@/modules/prices/queries";
import { getPurchaseReport, listPurchaseReportChoices } from "@/modules/purchase-reports/queries";
import { getGrni, getOrderChoices, listOrders, listOrdersToReceive, listReceipts as listGoodsReceipts } from "@/modules/purchasing/queries";
import { findCustomers, listCheques, listReceipts } from "@/modules/receipts/queries";
import { getCustomerRecovery, getCustomerStatement, listCustomerAgeing, listFollowUpsDue, listPromises, listRecoveryMarks } from "@/modules/recovery/queries";
import { getBalanceSheet, getCashFlow, getGeneralLedger, getOwnerFigures, getProfitAndLoss, getTrialBalance, LEDGER_FILE, listLedgerAccounts } from "@/modules/reports/queries";
import { getCustomerCredit, getSalesDocument, listOrdersOnHold, listOrdersToDeliver, listSalesDocuments, searchCustomers, searchItems } from "@/modules/sales/queries";
import { listShipments } from "@/modules/shipments/queries";
import { getStockReport, listStockReportChoices } from "@/modules/stock-reports/queries";
import { listBills } from "@/modules/supplier-bills/queries";
import { getWithholdingPosition, listPayments } from "@/modules/supplier-payments/queries";
import { listReturns } from "@/modules/supplier-returns/queries";
import { listActivity, listSignIns, loadWorkspace } from "@/modules/tenant/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql } from "../../tests/support/admin-db";
import { assertSafeDatabase, PERF_COMPANY } from "./seed";

// Times every list and every report of the performance company (Step 50), each through the
// app's own query, as its owner: `npm run perf:measure`, against the local database that
// `npm run perf:seed` filled. The plan's bar is 3 seconds; anything over PERF_LIMIT_MS (3000
// unless said) is marked, and the run fails if PERF_ENFORCE=1. Where PERF_REPORT names a file,
// the table is written there as Markdown.

export const LIMIT_MS = Number(process.env.PERF_LIMIT_MS ?? 3000);
type Timing = { area: string; name: string; best: number; worst: number; rows: number | null; failed?: string };

const sizeOf = (value: unknown): number | null => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length;
  }
  return null;
};

export async function measurePerf(): Promise<string[]> {
  assertSafeDatabase();
  const sql = adminSql();
  const timings: Timing[] = [];
  try {
    const [tenant] = await sql<{ id: string; created_by: string }[]>`select id, created_by from public.tenants where name = ${PERF_COMPANY}`;
    if (!tenant) throw new Error("There is no performance company. Run npm run perf:seed first.");
    const owner: TenantContext = { userId: tenant.created_by, email: "owner@perf.sahulaterp.test", tenantId: tenant.id, tenantName: PERF_COMPANY, role: "owner", branchIds: null };
    const one = async (query: ReturnType<typeof sql>) => ((await query) as unknown as { id: string }[])[0]?.id ?? "";
    // The busiest of each, so that the pages of one customer, item or supplier are timed at their worst.
    const customer = await one(sql`select customer_id as id from public.sales_documents where tenant_id = ${tenant.id} and kind = 'invoice' group by 1 order by count(*) desc limit 1`);
    const item = await one(sql`select item_id as id from public.stock_moves where tenant_id = ${tenant.id} group by 1 order by count(*) desc limit 1`);
    const supplier = await one(sql`select supplier_id as id from public.supplier_bills where tenant_id = ${tenant.id} group by 1 order by count(*) desc limit 1`);
    const seller = await one(sql`select user_id as id from public.commission_accruals where tenant_id = ${tenant.id} group by 1 order by count(*) desc limit 1`);
    const invoice = await one(sql`select id from public.sales_documents where tenant_id = ${tenant.id} and kind = 'invoice' and status = 'submitted' order by document_date desc, created_at desc limit 1`);
    const receivables = await one(sql`select id from public.accounts where tenant_id = ${tenant.id} and control_type = 'ar' and not is_group limit 1`);
    const [{ last }] = await sql<{ last: string }[]>`select max(journal_date)::text as last from public.journals where tenant_id = ${tenant.id}`;
    const [{ first }] = await sql<{ first: string }[]>`select min(journal_date)::text as first from public.journals where tenant_id = ${tenant.id}`;
    const today = last;
    const month = { from: `${last.slice(0, 8)}01`, to: last };
    const year = { from: first, to: last };

    const time = async (area: string, name: string, run: () => Promise<unknown>) => {
      const took: number[] = [];
      let rows: number | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const started = performance.now();
          rows = sizeOf(await run());
          took.push(performance.now() - started);
          // What takes this long once is not worth waiting for twice more.
          if (took[0] > 20_000) break;
        }
        timings.push({ area, name, best: Math.min(...took), worst: Math.max(...took), rows });
      } catch (error) {
        timings.push({ area, name, best: 0, worst: 0, rows: null, failed: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      }
    };
    const ledger = (period: { from: string; to: string }, accountId: string | null = null) => ({ ...period, branchId: null, accountId });
    const stock = (period: { from: string; to: string }, itemId: string | null = null) => ({ ...period, branchId: null, warehouseId: null, itemId });
    const buying = (period: { from: string; to: string }, supplierId: string | null = null) => ({ ...period, branchId: null, supplierId });

    // ── The frame of every page, and home ─────────────────────────────────────────────────────
    await time("Every page", "the company, its name and switches", () => loadWorkspace(owner.userId, owner.tenantId));
    await time("Home", "the owner's figures, month to date", () => getOwnerFigures(owner, ledger(month)));
    await time("Home", "needs attention: orders on hold", () => listOrdersOnHold(owner));
    await time("Home", "needs attention: cheques", () => listCheques(owner));

    // ── Selling ───────────────────────────────────────────────────────────────────────────────
    for (const kind of ["quotation", "order", "delivery", "invoice", "credit_note"] as const) await time("Sales", `list: ${kind}`, () => listSalesDocuments(owner, { kind }));
    await time("Sales", "list: invoices, searching a customer's name", () => listSalesDocuments(owner, { kind: "invoice", search: "Customer 12" }));
    await time("Sales", "list: invoices, searching a number", () => listSalesDocuments(owner, { kind: "invoice", search: "SI-" }));
    await time("Sales", "list: invoices, searching what nobody has", () => listSalesDocuments(owner, { kind: "invoice", search: "zzzz" }));
    await time("Sales", "orders to deliver", () => listOrdersToDeliver(owner));
    await time("Sales", "one invoice", () => getSalesDocument(owner, invoice));
    await time("Sales", "picker: customers", () => searchCustomers(owner, "trad"));
    await time("Sales", "picker: items", () => searchItems(owner, "part 1"));
    await time("Sales", "a customer's credit", () => getCustomerCredit(owner, customer));
    await time("Customers", "list", () => listParties(owner, "customer", {}));
    await time("Customers", "list, searching", () => listParties(owner, "customer", { search: "traders" }));
    await time("Suppliers", "list", () => listParties(owner, "supplier", {}));
    await time("Items", "list", () => listItems(owner, {}));
    await time("Items", "list, searching", () => listItems(owner, { search: "part 2" }));
    await time("Price lists", "list", () => listPriceLists(owner));

    // ── Money in, and recovery ────────────────────────────────────────────────────────────────
    await time("Receipts", "list", () => listReceipts(owner));
    await time("Receipts", "cheques, all", () => listCheques(owner, true));
    await time("Receipts", "picker: customers", () => findCustomers(owner, "trad"));
    await time("Recovery", "aged receivables", () => listCustomerAgeing(owner, today));
    await time("Recovery", "follow-up marks", () => listRecoveryMarks(owner, today));
    await time("Recovery", "follow-ups due", () => listFollowUpsDue(owner, today));
    await time("Recovery", "promises", () => listPromises(owner, today));
    await time("Recovery", "one customer", () => getCustomerRecovery(owner, customer, today));
    await time("Recovery", "customer statement, the month", () => getCustomerStatement(owner, customer, month));
    await time("Recovery", "customer statement, the year", () => getCustomerStatement(owner, customer, year));

    // ── Stock ─────────────────────────────────────────────────────────────────────────────────
    await time("Stock", "on hand", () => listStockOnHand(owner));
    await time("Stock", "transfers", () => listStockTransfers(owner));
    await time("Stock", "adjustments", () => listStockAdjustments(owner));
    await time("Stock", "counts", () => listStockCounts(owner));
    await time("Stock", "item choices", () => listItemChoices(owner));
    await time("Stock reports", "choices", () => listStockReportChoices(owner));
    for (const report of ["valuation", "movement", "ageing", "low-stock", "item-profit"] as const) {
      await time("Stock reports", `${report}, the month`, () => getStockReport(owner, report, stock(month), today));
      await time("Stock reports", `${report}, the year`, () => getStockReport(owner, report, stock(year), today));
    }
    await time("Stock reports", "movement of one item, the year", () => getStockReport(owner, "movement", stock(year, item), today));

    // ── The books ─────────────────────────────────────────────────────────────────────────────
    for (const [label, period] of [["the month", month], ["the year", year]] as const) {
      await time("Reports", `trial balance, ${label}`, () => getTrialBalance(owner, ledger(period)));
      await time("Reports", `profit and loss, ${label}`, () => getProfitAndLoss(owner, ledger(period)));
      await time("Reports", `balance sheet, ${label}`, () => getBalanceSheet(owner, ledger(period)));
      await time("Reports", `cash flow, ${label}`, () => getCashFlow(owner, ledger(period)));
      await time("Reports", `general ledger of trade receivables, ${label}`, () => getGeneralLedger(owner, ledger(period, receivables)));
    }
    await time("Reports", "general ledger of trade receivables, the year, as a file", () => getGeneralLedger(owner, ledger(year, receivables), LEDGER_FILE + 1));
    await time("Reports", "accounts to choose from", () => listLedgerAccounts(owner));
    await time("Journals", "list", () => listManualJournals(owner));

    // ── Buying ────────────────────────────────────────────────────────────────────────────────
    await time("Purchases", "orders", () => listOrders(owner));
    await time("Purchases", "orders to receive", () => listOrdersToReceive(owner));
    await time("Purchases", "goods received", () => listGoodsReceipts(owner));
    await time("Purchases", "order choices", () => getOrderChoices(owner));
    await time("Purchases", "bills", () => listBills(owner));
    await time("Purchases", "payments", () => listPayments(owner));
    await time("Purchases", "returns", () => listReturns(owner));
    await time("Purchases", "shipments", () => listShipments(owner));
    await time("Purchases", "withholding to pay", () => getWithholdingPosition(owner));
    await time("Purchases", "goods received not billed", () => getGrni(owner));
    await time("Buying reports", "choices", () => listPurchaseReportChoices(owner));
    for (const report of ["aged-payables", "withholding-register", "section-165", "grni"] as const) {
      await time("Buying reports", `${report}, the month`, () => getPurchaseReport(owner, report, buying(month)));
      await time("Buying reports", `${report}, the year`, () => getPurchaseReport(owner, report, buying(year)));
    }
    await time("Buying reports", "supplier statement, the year", () => getPurchaseReport(owner, "supplier-statement", buying(year, supplier)));

    // ── Commission, payroll, settings ─────────────────────────────────────────────────────────
    await time("Commission", "plans", () => listPlans(owner));
    await time("Commission", "earned, everyone", () => getEarned(owner));
    await time("Commission", "earned, one person", () => getEarned(owner, seller));
    await time("Commission", "payments", () => listCommissionPayments(owner));
    await time("Commission", "statements, the month", () => listStatements(owner, month));
    await time("Commission", "statements, the year", () => listStatements(owner, year));
    await time("Commission", "one statement, the year", () => getCommissionStatement(owner, seller, year));
    await time("Payroll", "employees", () => listEmployees(owner, { on: today }));
    await time("Settings", "activity", () => listActivity(owner));
    await time("Settings", "sign-ins", () => listSignIns(owner));

    const [sizes] = await sql<{ invoices: number; lines: number; journal_lines: number; moves: number }[]>`
      select (select count(*) from public.sales_documents where tenant_id = ${tenant.id} and kind = 'invoice' and status = 'submitted')::int as invoices,
             (select count(*) from public.sales_lines where tenant_id = ${tenant.id})::int as lines,
             (select count(*) from public.journal_lines where tenant_id = ${tenant.id})::int as journal_lines,
             (select count(*) from public.stock_moves where tenant_id = ${tenant.id})::int as moves`;
    const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(0)} ms`);
    const slow = timings.filter((timing) => timing.failed || timing.best > LIMIT_MS);
    const table = [
      `Company of ${sizes.invoices.toLocaleString("en")} posted invoices, ${sizes.lines.toLocaleString("en")} sales lines, ${sizes.journal_lines.toLocaleString("en")} journal lines, ${sizes.moves.toLocaleString("en")} stock moves. ${month.from} to ${month.to} is "the month"; ${year.from} to ${year.to} is "the year". Each is run three times; the bar is ${ms(LIMIT_MS)}.`,
      "",
      "| Where | What | Best | Worst | Rows | |",
      "|---|---|---:|---:|---:|---|",
      ...timings.map((timing) => (timing.failed ? `| ${timing.area} | ${timing.name} | | | | FAILED: ${timing.failed.replaceAll("|", "/")} |` : `| ${timing.area} | ${timing.name} | ${ms(timing.best)} | ${ms(timing.worst)} | ${timing.rows ?? ""} | ${timing.best > LIMIT_MS ? "SLOW" : ""} |`)),
    ];
    if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, `${table.join("\n")}\n`);
    const said = [...table, "", slow.length === 0 ? `All ${timings.length} under ${ms(LIMIT_MS)}.` : `${slow.length} of ${timings.length} over ${ms(LIMIT_MS)} or failed: ${slow.map((timing) => `${timing.area}, ${timing.name}`).join("; ")}`];
    if (process.env.PERF_ENFORCE === "1" && slow.length > 0) throw new Error(said.at(-1));
    return said;
  } finally {
    await sql.end();
    await closeDb();
  }
}
