import Decimal from "decimal.js";
import { formatAmount } from "@/lib/money";
import { getEarned } from "@/modules/commission-ledger/queries";
import { getCommissionStatement } from "@/modules/commission-statements/queries";
import { getPurchaseReport } from "@/modules/purchase-reports/queries";
import { getGrni } from "@/modules/purchasing/queries";
import { listCustomerAgeing } from "@/modules/recovery/queries";
import { getTrialBalance } from "@/modules/reports/queries";
import type { ReportTable } from "@/modules/reports/rules";
import { getStockReport } from "@/modules/stock-reports/queries";
import type { Demo } from "../world";

// The seed does not call itself done unless the books agree: the trial balance, the stock
// report with the stock account, what customers and suppliers owe with their accounts, the
// goods received and not billed with theirs, and the tax withheld and still to be paid with the
// withholding accounts. The figures the walk in docs/DEMO.md quotes are
// read here too, from the same reports the screens show.

const isAmount = (cell: unknown): cell is Decimal => Decimal.isDecimal(cell);
/** The last amount on the row whose label says this, or null when the report has no such row. */
function amountOn(table: ReportTable, label: string): Decimal | null {
  const row = table.rows.find((r) => r.cells.some((cell) => typeof cell === "string" && cell.startsWith(label)));
  const amounts = row?.cells.filter(isAmount) ?? [];
  return amounts.length > 0 ? amounts[amounts.length - 1] : null;
}

export async function checkBooks(d: Demo): Promise<void> {
  const { owner, today, lastMonth, thisMonth, shift } = d;
  const from = `${d.fyYear}-07-01`;
  const problems: string[] = [];
  const agree = (what: string, one: Decimal | null, other: Decimal | null) => {
    if (one === null || other === null || !one.equals(other)) problems.push(`${what}: ${one === null ? "missing" : formatAmount(one)} against ${other === null ? "missing" : formatAmount(other)}`);
  };
  const balanceOf = async (controls: string[]) => {
    const [row] = await d.sql<{ balance: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0)::text as balance from public.journal_lines l
      join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ${d.tenantId} and a.control_type = any(${controls})`;
    return new Decimal(row.balance);
  };

  const trial = await getTrialBalance(owner, { from, to: today, branchId: null, accountId: null });
  const grand = trial.rows.find((row) => row.kind === "grand")?.cells.filter(isAmount) ?? [];
  agree("Trial balance, debits and credits of the period", grand[2] ?? null, grand[3] ?? null);
  agree("Trial balance, closing debits and credits", grand[4] ?? null, grand[5] ?? null);
  if (trial.notes.length > 0) problems.push(`Trial balance: ${trial.notes.join(" ")}`);

  const stock = await getStockReport(owner, "valuation", { from, to: today, branchId: null, warehouseId: null, itemId: null }, today);
  agree("Stock valuation and the stock account", amountOn(stock, "Total"), amountOn(stock, "Stock account in the books"));

  const payables = await getPurchaseReport(owner, "aged-payables", { from, to: today, branchId: null, supplierId: null });
  agree("Aged payables and the payables accounts", amountOn(payables, "Total"), amountOn(payables, "Trade payables less advances"));

  const ageing = await listCustomerAgeing(owner, today);
  const owedByCustomers = ageing.reduce((sum, row) => sum.plus(row.total), new Decimal(0));
  // What customers owe is the receivables account itself; money they paid ahead, and credit
  // notes not yet set against an invoice, are held in Advances from customers beside it.
  agree("Aged receivables and the receivables account", owedByCustomers, await balanceOf(["ar"]));

  const unbilled = await getGrni(owner);
  agree("Goods received not billed and its account", unbilled.total, unbilled.ledger);

  // Tax withheld from suppliers, on bills and on expenses, and deducted from salaries by the payroll runs.
  const register = await getPurchaseReport(owner, "withholding-register", { from, to: today, branchId: null, supplierId: null });
  agree("Tax withheld and still to be paid, and the withholding accounts", amountOn(register, "Withheld and not yet paid over"), amountOn(register, "Withholding payable accounts in the books"));

  if (problems.length > 0) throw new Error(`The demo's books do not agree:\n  ${problems.join("\n  ")}`);
  d.said.push(`The books agree: trial balance ${formatAmount(grand[4] ?? new Decimal(0))} each side; stock ${formatAmount(amountOn(stock, "Total")!)}; customers owe ${formatAmount(owedByCustomers)}; suppliers are owed ${formatAmount(amountOn(payables, "Total")!)}; goods received and not billed ${formatAmount(unbilled.total)}; tax withheld and still to be paid ${formatAmount(amountOn(register, "Withheld and not yet paid over")!)}.`);

  // ── What the walk quotes ────────────────────────────────────────────────────────────────────
  const ali = d.people.ALI.id;
  const last = await getCommissionStatement(owner, ali, { from: lastMonth, to: shift(thisMonth, -1) });
  const now = await getCommissionStatement(owner, ali, { from: thisMonth, to: today });
  const earned = await getEarned(owner, ali);
  const totals = earned.people.find((person) => person.userId === ali)?.totals;
  if (!last || !now || !totals) throw new Error("Ali's commission statement could not be read.");
  Object.assign(d.facts, {
    aliEarnedLastMonth: formatAmount(last.statement.period.earned),
    aliReleasedLastMonth: formatAmount(last.statement.period.released),
    aliPaidThisMonth: formatAmount(now.statement.period.paid),
    aliOwedBack: formatAmount(totals.owedBack),
    aliPayable: formatAmount(totals.payable),
    aliOwedAtEnd: formatAmount(now.statement.closing.released.minus(now.statement.closing.paid)),
    splitInvoice: d.invoices[3]?.number ?? "",
    trialBalance: formatAmount(grand[4] ?? new Decimal(0)),
    stockValue: formatAmount(amountOn(stock, "Total")!),
    customersOwe: formatAmount(owedByCustomers),
    suppliersOwed: formatAmount(amountOn(payables, "Total")!),
    goodsNotBilled: formatAmount(unbilled.total),
    taxStillToPay: formatAmount(amountOn(register, "Withheld and not yet paid over")!),
    salaryTax: formatAmount(amountOn(register, "Total, income tax deducted from salaries") ?? new Decimal(0)),
  });
}
