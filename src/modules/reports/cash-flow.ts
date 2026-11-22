import Decimal from "decimal.js";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import type { ReportAccount, ReportRow, ReportTable } from "./rules";

// Step 36: the cash-flow statement, by the direct method. Pure rules: no database here.
//
// Every journal that moved money in or out of a cash or bank account is read, and the money it
// moved is put down to what it was set against: a receipt against what a customer owed is money
// from customers, a payment against what a supplier was owed is money to suppliers, and so on.
// The lines are those very journals' own lines, so the statement adds up, by its making, to what
// the cash and bank accounts moved in the period: the step's acceptance.

const ZERO = new Decimal(0);

/** Where money came from or went to. */
export const FLOWS = ["customers", "suppliers", "staff", "taxes", "other", "assets", "loans", "owners", "opening"] as const;
export type Flow = (typeof FLOWS)[number];

const FLOW_LABELS: Record<Flow, string> = {
  customers: "Received from customers",
  suppliers: "Paid to suppliers",
  staff: "Paid to staff",
  taxes: "Taxes, EOBI and social security",
  other: "Other receipts and payments",
  assets: "Fixed assets bought and sold",
  loans: "Loans taken and repaid",
  owners: "Owners' capital and drawings",
  opening: "Opening balances entered",
};

/** The locked accounts whose money is a customer's, a supplier's, staff's or a tax. */
const BY_CONTROL: Record<string, Flow> = {
  ar: "customers",
  customer_advances: "customers",
  cheques_in_hand: "customers",
  sales: "customers",
  ap: "suppliers",
  grni: "suppliers",
  supplier_advances: "suppliers",
  inventory: "suppliers",
  goods_in_transit: "suppliers",
  purchase_price_difference: "suppliers",
  payroll_payable: "staff",
  commission_payable: "staff",
  salaries_expense: "staff",
  commission_expense: "staff",
  input_tax: "taxes",
  output_tax: "taxes",
  further_tax: "taxes",
  advance_income_tax: "taxes",
  wht_income_tax: "taxes",
  wht_sales_tax: "taxes",
  wht_provincial_tax: "taxes",
  payroll_statutory_payable: "taxes",
  payroll_statutory_expense: "taxes",
  // Cash put in against Opening balance equity is an opening balance, however it was entered.
  opening_equity: "opening",
};

/** Cash and bank accounts: what the statement is about, never what money is set against. */
export const isCash = (account: Pick<ReportAccount, "controlType">) => account.controlType === "cash" || account.controlType === "bank";

/**
 * What an account's money is, for the statement: by what the account is for when it is a locked
 * one; otherwise fixed assets under the Fixed assets heading (1500), loans under Long-term
 * liabilities (2500), the owners' under Equity; anything else is other operating money.
 */
export function flowOf(account: ReportAccount, byId: ReadonlyMap<string, ReportAccount>): Flow {
  const control = account.controlType ? BY_CONTROL[account.controlType] : undefined;
  if (control) return control;
  if (account.type === "equity") return "owners";
  for (let up = account.parentId ? byId.get(account.parentId) : undefined, depth = 0; up && depth < 8; up = up.parentId ? byId.get(up.parentId) : undefined, depth += 1) {
    if (up.code === "1500") return "assets";
    if (up.code === "2500") return "loans";
  }
  return "other";
}

/**
 * One account's lines in one journal that moved cash or bank in the period: debits less credits.
 * A journal is wholly in one branch (its lines take its branch), so a branch asked for takes whole
 * journals. `sourceType` of a reversal is "reversal:" and what it reverses.
 */
export type CashFlowEntry = { journalId: string; sourceType: string; accountId: string; net: Decimal };

const OPENING_SOURCES = new Set(["opening_balance", "reversal:opening_balance"]);

export type CashFlow = {
  flows: Record<Flow, Decimal>;
  operating: Decimal;
  investing: Decimal;
  financing: Decimal;
  net: Decimal;
  opening: Decimal;
  closing: Decimal;
  /** The cash and bank accounts' own movement in the period; equal to `net` in books that balance. */
  moved: Decimal;
};

/** `amount` shared out in proportion to `weights`, to the books' four places, the shares adding up to it exactly (largest remainder). */
function shareOut(amount: Decimal, weights: ReadonlyMap<Flow, Decimal>, total: Decimal): Map<Flow, Decimal> {
  const unit = new Decimal("0.0001");
  const raw = [...weights].map(([flow, weight]) => ({ flow, exact: amount.times(weight).div(total) }));
  const shares = raw.map((r) => ({ flow: r.flow, share: r.exact.toDecimalPlaces(4, Decimal.ROUND_DOWN), rest: r.exact.minus(r.exact.toDecimalPlaces(4, Decimal.ROUND_DOWN)) }));
  let left = amount.minus(shares.reduce((t, s) => t.plus(s.share), ZERO));
  const step = left.isNegative() ? unit.negated() : unit;
  for (const s of [...shares].sort((a, b) => (left.isNegative() ? a.rest.comparedTo(b.rest) : b.rest.comparedTo(a.rest)))) {
    if (left.isZero()) break;
    s.share = s.share.plus(step);
    left = left.minus(step);
  }
  return new Map(shares.map((s) => [s.flow, s.share]));
}

/**
 * The statement for a period. `opening` and `closing` are what the cash and bank accounts held
 * before the period and at its end (one branch's, when asked). Each journal's money in or out of
 * cash and bank is put down to what it was set against on the same side: money in to what was
 * credited, money out to what was debited (so an expense paid less tax withheld is all of it paid
 * out on the expense: the tax is money out when it is paid to the government). Tax in a journal
 * with a customer's or a supplier's account is theirs (a cash sale's sales tax is money from the
 * customer). Several kinds share the money in proportion. An opening-balance journal, or its
 * reversal, is shown as such. Money set against nothing on its side (a journal that should not
 * exist: cash against cash on both sides) is other money, so the statement still adds up.
 */
export function cashFlow(accounts: readonly ReportAccount[], entries: readonly CashFlowEntry[], opening: Decimal, closing: Decimal): CashFlow {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const flows = Object.fromEntries(FLOWS.map((flow) => [flow, ZERO])) as Record<Flow, Decimal>;
  const add = (flow: Flow, amount: Decimal) => (flows[flow] = flows[flow].plus(amount));
  const journals = new Map<string, CashFlowEntry[]>();
  for (const entry of entries) {
    const lines = journals.get(entry.journalId);
    if (lines) lines.push(entry);
    else journals.set(entry.journalId, [entry]);
  }
  let moved = ZERO;
  for (const lines of journals.values()) {
    const money = lines.filter((line) => isCash(byId.get(line.accountId) ?? { controlType: null })).reduce((t, line) => t.plus(line.net), ZERO);
    moved = moved.plus(money);
    if (money.isZero()) continue;
    if (OPENING_SOURCES.has(lines[0].sourceType)) {
      add("opening", money);
      continue;
    }
    // What each kind of account was credited (money in) or debited (money out, negative).
    const weights = new Map<Flow, Decimal>();
    for (const line of lines) {
      const account = byId.get(line.accountId);
      if (!account || isCash(account)) continue;
      const flow = flowOf(account, byId);
      weights.set(flow, (weights.get(flow) ?? ZERO).minus(line.net));
    }
    const party = weights.has("customers") && !weights.has("suppliers") ? "customers" : weights.has("suppliers") && !weights.has("customers") ? "suppliers" : null;
    if (party && weights.has("taxes")) {
      weights.set(party, weights.get(party)!.plus(weights.get("taxes")!));
      weights.delete("taxes");
    }
    const sameSide = new Map([...weights].filter(([, weight]) => !weight.isZero() && weight.isNegative() === money.isNegative()));
    const total = [...sameSide.values()].reduce((t, w) => t.plus(w), ZERO);
    if (total.isZero()) {
      add("other", money);
    } else if (total.eq(money)) {
      for (const [flow, weight] of sameSide) add(flow, weight);
    } else {
      for (const [flow, share] of shareOut(money, sameSide, total)) add(flow, share);
    }
  }
  const operating = flows.customers.plus(flows.suppliers).plus(flows.staff).plus(flows.taxes).plus(flows.other);
  const investing = flows.assets;
  const financing = flows.loans.plus(flows.owners);
  const net = operating.plus(investing).plus(financing).plus(flows.opening);
  return { flows, operating, investing, financing, net, opening, closing, moved };
}

/** The statement as a report table, for the screen, the printer and the file. */
export function cashFlowTable(report: CashFlow, filter: { from: string; to: string }, title: string): ReportTable {
  const line = (flow: Flow): ReportRow[] => (report.flows[flow].isZero() ? [] : [{ kind: "line", depth: 1, cells: [FLOW_LABELS[flow], report.flows[flow]] }]);
  const agrees = report.net.eq(report.closing.minus(report.opening)) && report.net.eq(report.moved);
  return {
    title,
    period: `${formatIsoDate(filter.from)} to ${formatIsoDate(filter.to)}`,
    columns: [
      { label: "", numeric: false },
      { label: "Amount", numeric: true },
    ],
    rows: [
      { kind: "heading", depth: 0, cells: ["Operating activities", null] },
      ...(["customers", "suppliers", "staff", "taxes", "other"] as const).flatMap(line),
      { kind: "total", depth: 0, cells: ["Net cash from operating activities", report.operating] },
      { kind: "heading", depth: 0, cells: ["Investing activities", null] },
      ...line("assets"),
      { kind: "total", depth: 0, cells: ["Net cash from investing activities", report.investing] },
      { kind: "heading", depth: 0, cells: ["Financing activities", null] },
      ...line("loans"),
      ...line("owners"),
      { kind: "total", depth: 0, cells: ["Net cash from financing activities", report.financing] },
      ...(report.flows.opening.isZero() ? [] : [{ kind: "total", depth: 0, cells: [FLOW_LABELS.opening, report.flows.opening] } as ReportRow]),
      { kind: "grand", depth: 0, cells: ["Net change in cash and bank", report.net] },
      { kind: "line", depth: 0, cells: ["Cash and bank at the start", report.opening] },
      { kind: "line", depth: 0, cells: ["Cash and bank at the end", report.closing] },
    ],
    notes: agrees
      ? [`The net change, ${formatAmount(report.net)}, is what the cash and bank accounts moved in the period: from ${formatAmount(report.opening)} to ${formatAmount(report.closing)}.`]
      : [`The net change does not agree with what the cash and bank accounts moved (${formatAmount(report.closing.minus(report.opening))}). Please report it.`],
  };
}

// ── The owner's figures (Step 36) ───────────────────────────────────────────────────────────────

export type OwnerFigures = {
  /** What the cash and bank accounts hold at the end of the period, and how much that moved in it. */
  cash: Decimal;
  cashChange: Decimal;
  /** The Sales account's credits less its debits in the period. */
  sales: Decimal;
  /** Income less expenses in the period; negative for a loss. */
  profit: Decimal;
  /** What customers owe, and what is owed to suppliers, at the end of the period. */
  receivables: Decimal;
  payables: Decimal;
};

/**
 * The owner's home figures for a period, from one set of totals (debits less credits before the
 * period, and debits and credits within it). Nothing is worked out that the reports do not show
 * the same way: cash as the cash-flow statement ends, sales and profit as the profit and loss.
 */
export function ownerFigures(accounts: readonly ReportAccount[], totals: ReadonlyMap<string, { before: Decimal; debit: Decimal; credit: Decimal }>): OwnerFigures {
  let cash = ZERO;
  let cashChange = ZERO;
  let sales = ZERO;
  let profit = ZERO;
  let receivables = ZERO;
  let payables = ZERO;
  for (const account of accounts) {
    if (account.isGroup) continue;
    const total = totals.get(account.id);
    if (!total) continue;
    const moved = total.debit.minus(total.credit);
    const closing = total.before.plus(moved);
    if (isCash(account)) {
      cash = cash.plus(closing);
      cashChange = cashChange.plus(moved);
    }
    if (account.controlType === "sales") sales = sales.minus(moved);
    if (account.type === "income" || account.type === "expense") profit = profit.minus(moved);
    if (account.controlType === "ar") receivables = receivables.plus(closing);
    if (account.controlType === "ap") payables = payables.minus(closing);
  }
  return { cash, cashChange, sales, profit, receivables, payables };
}
