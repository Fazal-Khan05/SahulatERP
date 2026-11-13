import Decimal from "decimal.js";
import { formatAmount } from "@/lib/money";
import { isIsoDate, formatIsoDate } from "@/modules/currencies/rules";
import { chartOrder, type Account, type AccountType } from "@/modules/ledger/rules";

// Pure rules for the four ledger reports. No I/O.
//
// Every report is built from the same thing: for each account, what it stood at before a period
// and its debits and credits within the period, all read from posted journal lines. Nothing here
// recomputes an amount a posting stored; the reports only add up. A balance is kept as "debits
// less credits", so an asset is positive and a liability negative, until a report shows it the
// way a reader expects.

/** What a report needs to know about an account. */
export type ReportAccount = Pick<Account, "id" | "parentId" | "code" | "name" | "type" | "isGroup" | "controlType">;

/** One account's figures: `before` is debits less credits before the period; the rest are within it. */
export type AccountTotal = { before: Decimal; debit: Decimal; credit: Decimal };
export type Totals = ReadonlyMap<string, AccountTotal>;

const ZERO = new Decimal(0);
const NONE: AccountTotal = { before: ZERO, debit: ZERO, credit: ZERO };
const sum = (values: readonly Decimal[]) => values.reduce((total, value) => total.plus(value), ZERO);

/** Debits less credits at the end of the period. */
const closing = (total: AccountTotal) => total.before.plus(total.debit).minus(total.credit);
/** Debits less credits within the period. */
const movement = (total: AccountTotal) => total.debit.minus(total.credit);

/** Assets and expenses grow with debits; liabilities, equity and income with credits. */
export const growsWithDebit = (type: AccountType): boolean => type === "asset" || type === "expense";
const isProfitAndLoss = (type: AccountType): boolean => type === "income" || type === "expense";

// ── Trial balance ───────────────────────────────────────────────────────────────────────────────

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  /** Debits less credits before the period, in the period's debits and credits, and after it. */
  opening: Decimal;
  debit: Decimal;
  credit: Decimal;
  closing: Decimal;
};

export type TrialBalance = {
  rows: TrialBalanceRow[];
  totals: { openingDebit: Decimal; openingCredit: Decimal; debit: Decimal; credit: Decimal; closingDebit: Decimal; closingCredit: Decimal };
};

const debitSide = (balance: Decimal) => (balance.isPositive() ? balance : ZERO);
const creditSide = (balance: Decimal) => (balance.isNegative() ? balance.abs() : ZERO);

/**
 * The trial balance for a period: every account that stood at something or moved, by code, with
 * what it opened at, its debits and credits, and what it closed at. In books that balance, each
 * pair of totals is equal.
 */
export function trialBalance(accounts: readonly ReportAccount[], totals: Totals): TrialBalance {
  const rows = chartOrder(accounts.filter((account) => !account.isGroup || totals.has(account.id)).map((account) => ({ ...account, parentId: null })))
    .map((account) => {
      const total = totals.get(account.id) ?? NONE;
      return { accountId: account.id, code: account.code, name: account.name, opening: total.before, debit: total.debit, credit: total.credit, closing: closing(total) };
    })
    .filter((row) => !row.opening.isZero() || !row.debit.isZero() || !row.credit.isZero());
  return {
    rows,
    totals: {
      openingDebit: sum(rows.map((row) => debitSide(row.opening))),
      openingCredit: sum(rows.map((row) => creditSide(row.opening))),
      debit: sum(rows.map((row) => row.debit)),
      credit: sum(rows.map((row) => row.credit)),
      closingDebit: sum(rows.map((row) => debitSide(row.closing))),
      closingCredit: sum(rows.map((row) => creditSide(row.closing))),
    },
  };
}

// ── The chart with amounts ──────────────────────────────────────────────────────────────────────

export type TreeRow = { accountId: string; code: string; name: string; depth: number; isGroup: boolean; amount: Decimal };

/**
 * The accounts of some types in chart order, each with its amount, and each heading with the sum
 * of everything under it. Accounts and headings that come to nothing are left out. `amountOf`
 * says what an account's figure is, already turned the way the report shows it.
 */
export function amountsTree(accounts: readonly ReportAccount[], types: readonly AccountType[], amountOf: (account: ReportAccount) => Decimal): TreeRow[] {
  const wanted = chartOrder(accounts.filter((account) => types.includes(account.type)));
  const own = new Map(wanted.map((account) => [account.id, account.isGroup ? ZERO : amountOf(account)]));
  const total = new Map(own);
  // Children come after their parents in chart order, so adding from the end rolls every amount up.
  for (const account of [...wanted].reverse()) {
    if (account.parentId !== null && total.has(account.parentId)) total.set(account.parentId, (total.get(account.parentId) ?? ZERO).plus(total.get(account.id) ?? ZERO));
  }
  const hasAmount = new Set<string>();
  for (const account of [...wanted].reverse()) {
    if (!(own.get(account.id) ?? ZERO).isZero() || hasAmount.has(account.id)) {
      hasAmount.add(account.id);
      if (account.parentId !== null) hasAmount.add(account.parentId);
    }
  }
  return wanted
    .filter((account) => hasAmount.has(account.id))
    .map((account) => ({ accountId: account.id, code: account.code, name: account.name, depth: account.depth, isGroup: account.isGroup, amount: total.get(account.id) ?? ZERO }));
}

const rootTotal = (rows: readonly TreeRow[]) => sum(rows.filter((row) => row.depth === 0).map((row) => row.amount));

// ── Profit and loss ─────────────────────────────────────────────────────────────────────────────

export type ProfitAndLoss = {
  income: TreeRow[];
  expenses: TreeRow[];
  totalIncome: Decimal;
  totalExpenses: Decimal;
  netProfit: Decimal;
  /** Sales less cost of goods sold: what the goods themselves earned, before the running costs. */
  sales: Decimal;
  costOfGoodsSold: Decimal;
  grossProfit: Decimal;
};

/**
 * Profit and loss for a period: income, less expenses, from the period's own debits and credits.
 * Income is shown as credits less debits and expenses as debits less credits, so both read as
 * positive figures; net profit is negative for a loss.
 */
export function profitAndLoss(accounts: readonly ReportAccount[], totals: Totals): ProfitAndLoss {
  const moved = (account: ReportAccount) => movement(totals.get(account.id) ?? NONE);
  const income = amountsTree(accounts, ["income"], (account) => moved(account).negated());
  const expenses = amountsTree(accounts, ["expense"], moved);
  const totalIncome = rootTotal(income);
  const totalExpenses = rootTotal(expenses);
  const control = (type: string, turn: (value: Decimal) => Decimal) => sum(accounts.filter((account) => !account.isGroup && account.controlType === type).map((account) => turn(moved(account))));
  const sales = control("sales", (value) => value.negated());
  const costOfGoodsSold = control("cogs", (value) => value);
  return { income, expenses, totalIncome, totalExpenses, netProfit: totalIncome.minus(totalExpenses), sales, costOfGoodsSold, grossProfit: sales.minus(costOfGoodsSold) };
}

// ── Balance sheet ───────────────────────────────────────────────────────────────────────────────

export type BalanceSheet = {
  assets: TreeRow[];
  liabilities: TreeRow[];
  equity: TreeRow[];
  /**
   * Profit made in earlier fiscal years that no closing entry has moved into retained earnings
   * yet, and the profit of the current fiscal year up to the date. Both belong to the owners.
   */
  earlierProfit: Decimal;
  profitThisYear: Decimal;
  totalAssets: Decimal;
  totalLiabilities: Decimal;
  totalEquity: Decimal;
  /** Assets less liabilities less equity: nil in books that balance. */
  difference: Decimal;
};

/**
 * The balance sheet at the end of a period that starts with the fiscal year: what the company
 * owns, what it owes, and what is left for its owners. `totals` must be for the period from the
 * first day of the fiscal year to the date, so that `before` holds the earlier years.
 *
 * Income and expense accounts are never closed by an entry here, so their balance to date is
 * shown under equity as profit: the earlier years' in one line, this year's in another.
 */
export function balanceSheet(accounts: readonly ReportAccount[], totals: Totals): BalanceSheet {
  const closed = (account: ReportAccount) => closing(totals.get(account.id) ?? NONE);
  const assets = amountsTree(accounts, ["asset"], closed);
  const liabilities = amountsTree(accounts, ["liability"], (account) => closed(account).negated());
  const equity = amountsTree(accounts, ["equity"], (account) => closed(account).negated());
  const results = accounts.filter((account) => !account.isGroup && isProfitAndLoss(account.type));
  const earlierProfit = sum(results.map((account) => (totals.get(account.id) ?? NONE).before)).negated();
  const profitThisYear = sum(results.map((account) => movement(totals.get(account.id) ?? NONE))).negated();
  const totalAssets = rootTotal(assets);
  const totalLiabilities = rootTotal(liabilities);
  const totalEquity = rootTotal(equity).plus(earlierProfit).plus(profitThisYear);
  return { assets, liabilities, equity, earlierProfit, profitThisYear, totalAssets, totalLiabilities, totalEquity, difference: totalAssets.minus(totalLiabilities).minus(totalEquity) };
}

/**
 * What the owners have earned and left in the business up to the end of the period: the
 * retained earnings account itself, plus every income and expense account's balance to date
 * (profit no closing entry has moved there yet). See retainedEarningsStatement for how it
 * changes over a period.
 */
export function retainedEarnings(accounts: readonly ReportAccount[], totals: Totals): Decimal {
  const counted = accounts.filter((account) => !account.isGroup && (account.controlType === "retained_earnings" || isProfitAndLoss(account.type)));
  return sum(counted.map((account) => closing(totals.get(account.id) ?? NONE))).negated();
}

/**
 * How what the owners have earned changed over a period: what it opened at, the period's profit,
 * anything posted straight to the retained earnings account (opening balances brought from old
 * books, a correction, a dividend), and what it closed at. Opening plus profit plus direct
 * postings is always the closing figure; so the period's profit is the change in retained
 * earnings less what was posted to it directly.
 */
export function retainedEarningsStatement(accounts: readonly ReportAccount[], totals: Totals): { opening: Decimal; netProfit: Decimal; direct: Decimal; closing: Decimal } {
  const before = new Map([...totals].map(([id, total]): [string, AccountTotal] => [id, { before: total.before, debit: ZERO, credit: ZERO }]));
  const direct = sum(accounts.filter((account) => !account.isGroup && account.controlType === "retained_earnings").map((account) => movement(totals.get(account.id) ?? NONE))).negated();
  return { opening: retainedEarnings(accounts, before), netProfit: profitAndLoss(accounts, totals).netProfit, direct, closing: retainedEarnings(accounts, totals) };
}

// ── General ledger ──────────────────────────────────────────────────────────────────────────────

export type LedgerEntry = {
  date: string;
  /** The source document's number, or what the journal is when it has none. */
  reference: string;
  description: string;
  debit: Decimal;
  credit: Decimal;
};

export type LedgerLine = LedgerEntry & { balance: Decimal };

/** An account's entries in order, each with the balance (debits less credits) after it. */
export function runningBalance(opening: Decimal, entries: readonly LedgerEntry[]): { lines: LedgerLine[]; debit: Decimal; credit: Decimal; closing: Decimal } {
  let balance = opening;
  const lines = entries.map((entry) => {
    balance = balance.plus(entry.debit).minus(entry.credit);
    return { ...entry, balance };
  });
  return { lines, debit: sum(entries.map((entry) => entry.debit)), credit: sum(entries.map((entry) => entry.credit)), closing: balance };
}

// ── What was asked for ──────────────────────────────────────────────────────────────────────────

export const REPORTS = {
  "trial-balance": { title: "Trial balance", about: "Every account with what it opened at, its debits and credits, and what it closed at." },
  "general-ledger": { title: "General ledger", about: "Every entry in one account, in order, with the balance after each." },
  "balance-sheet": { title: "Balance sheet", about: "What the company owns, what it owes, and what is left for its owners, on one day." },
  "profit-and-loss": { title: "Profit and loss", about: "Income less expenses over a period." },
} as const;
export type ReportKey = keyof typeof REPORTS;
export const isReportKey = (value: unknown): value is ReportKey => typeof value === "string" && Object.hasOwn(REPORTS, value);

export type ReportFilter = { from: string; to: string; branchId: string | null; accountId: string | null };

const text = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * The period and branch a report was asked for. With nothing given it is the fiscal year so
 * far: from `yearStart` to `today`. A day that was asked for is never moved: when only the end
 * is given and it is before `yearStart`, the period starts on that day too, and when only the
 * start is given and it is after `today`, the period ends on it. Only a period given whole and
 * backwards is put right, by swapping its ends.
 */
export function readFilter(raw: { from?: unknown; to?: unknown; branch?: unknown; account?: unknown }, defaults: { yearStart: string; today: string }): ReportFilter {
  const typedFrom = text(raw.from);
  const typedTo = text(raw.to);
  const givenFrom = isIsoDate(typedFrom) ? typedFrom : null;
  const givenTo = isIsoDate(typedTo) ? typedTo : null;
  let to = givenTo ?? (givenFrom !== null && givenFrom > defaults.today ? givenFrom : defaults.today);
  let from = givenFrom ?? (defaults.yearStart <= to ? defaults.yearStart : to);
  if (from > to) [from, to] = [to, from];
  const id = (value: unknown) => {
    const typed = text(value);
    return typeof typed === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(typed) ? typed.toLowerCase() : null;
  };
  return { from, to, branchId: id(raw.branch), accountId: id(raw.account) };
}

/** The filter as the part of an address after "?", for the links to print and download. */
export function filterQuery(filter: ReportFilter, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ from: filter.from, to: filter.to });
  if (filter.branchId) query.set("branch", filter.branchId);
  if (filter.accountId) query.set("account", filter.accountId);
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

// ── One table for the screen, the printer and the file ──────────────────────────────────────────

/** A cell is words, an amount, or nothing. */
export type Cell = string | Decimal | null;
export type ReportRow = {
  /** `heading` starts a section; `line` is an account; `total` sums what is above it; `grand` is a report's bottom line. */
  kind: "heading" | "line" | "total" | "grand";
  /** How far the first cell is set in, for accounts under headings. */
  depth: number;
  cells: Cell[];
};
export type ReportTable = {
  title: string;
  /** The period or the day, in words. */
  period: string;
  columns: { label: string; numeric: boolean }[];
  rows: ReportRow[];
  /** Anything the reader should be told under the table. */
  notes: string[];
};

const period = (from: string, to: string) => `${formatIsoDate(from)} to ${formatIsoDate(to)}`;
const blankIfZero = (value: Decimal): Cell => (value.isZero() ? null : value);

export function trialBalanceTable(report: TrialBalance, filter: Pick<ReportFilter, "from" | "to">): ReportTable {
  const { totals } = report;
  const agree = totals.debit.eq(totals.credit) && totals.closingDebit.eq(totals.closingCredit) && totals.openingDebit.eq(totals.openingCredit);
  return {
    title: REPORTS["trial-balance"].title,
    period: period(filter.from, filter.to),
    columns: [
      { label: "Code", numeric: false },
      { label: "Account", numeric: false },
      { label: "Opening debit", numeric: true },
      { label: "Opening credit", numeric: true },
      { label: "Debits", numeric: true },
      { label: "Credits", numeric: true },
      { label: "Closing debit", numeric: true },
      { label: "Closing credit", numeric: true },
    ],
    rows: [
      ...report.rows.map((row): ReportRow => ({
        kind: "line",
        depth: 0,
        cells: [row.code, row.name, blankIfZero(debitSide(row.opening)), blankIfZero(creditSide(row.opening)), blankIfZero(row.debit), blankIfZero(row.credit), blankIfZero(debitSide(row.closing)), blankIfZero(creditSide(row.closing))],
      })),
      { kind: "grand", depth: 0, cells: ["", "Total", totals.openingDebit, totals.openingCredit, totals.debit, totals.credit, totals.closingDebit, totals.closingCredit] },
    ],
    notes: agree ? [] : ["The totals do not agree. If this report is for one branch, an entry may have been split across branches; otherwise please report it."],
  };
}

const treeRows = (rows: readonly TreeRow[]): ReportRow[] =>
  rows.map((row) => ({ kind: row.isGroup ? (row.depth === 0 ? "heading" : "total") : "line", depth: row.depth, cells: [row.isGroup && row.depth === 0 ? row.name : `${row.code} ${row.name}`, row.depth === 0 ? null : row.amount] }));

const AMOUNT_COLUMNS = [
  { label: "Account", numeric: false },
  { label: "Amount", numeric: true },
];

export function profitAndLossTable(report: ProfitAndLoss, filter: Pick<ReportFilter, "from" | "to">): ReportTable {
  return {
    title: REPORTS["profit-and-loss"].title,
    period: period(filter.from, filter.to),
    columns: AMOUNT_COLUMNS,
    rows: [
      ...(report.income.length > 0 ? treeRows(report.income) : [{ kind: "heading", depth: 0, cells: ["Income", null] } as ReportRow]),
      { kind: "total", depth: 0, cells: ["Total income", report.totalIncome] },
      ...(report.expenses.length > 0 ? treeRows(report.expenses) : [{ kind: "heading", depth: 0, cells: ["Expenses", null] } as ReportRow]),
      { kind: "total", depth: 0, cells: ["Total expenses", report.totalExpenses] },
      { kind: "grand", depth: 0, cells: [report.netProfit.isNegative() ? "Net loss" : "Net profit", report.netProfit] },
    ],
    notes:
      report.sales.isZero() && report.costOfGoodsSold.isZero()
        ? []
        : [`Gross profit, counting only the Sales account and the Cost of goods sold account: ${formatAmount(report.sales)} less ${formatAmount(report.costOfGoodsSold)} is ${formatAmount(report.grossProfit)}. Other income, returns and stock adjustments kept in other accounts are not part of it.`],
  };
}

export function balanceSheetTable(report: BalanceSheet, asAt: string): ReportTable {
  const section = (name: string, rows: readonly TreeRow[]): ReportRow[] => (rows.length > 0 ? treeRows(rows) : [{ kind: "heading", depth: 0, cells: [name, null] }]);
  return {
    title: REPORTS["balance-sheet"].title,
    period: `As at the end of ${formatIsoDate(asAt)}`,
    columns: AMOUNT_COLUMNS,
    rows: [
      ...section("Assets", report.assets),
      { kind: "grand", depth: 0, cells: ["Total assets", report.totalAssets] },
      ...section("Liabilities", report.liabilities),
      { kind: "total", depth: 0, cells: ["Total liabilities", report.totalLiabilities] },
      ...section("Equity", report.equity),
      ...(report.earlierProfit.isZero() ? [] : [{ kind: "line", depth: 1, cells: ["Profit of earlier years, not yet moved to retained earnings", report.earlierProfit] } as ReportRow]),
      { kind: "line", depth: 1, cells: [report.profitThisYear.isNegative() ? "Loss for this fiscal year so far" : "Profit for this fiscal year so far", report.profitThisYear] },
      { kind: "total", depth: 0, cells: ["Total equity", report.totalEquity] },
      { kind: "grand", depth: 0, cells: ["Total liabilities and equity", report.totalLiabilities.plus(report.totalEquity)] },
    ],
    notes: report.difference.isZero() ? [] : [`Assets and liabilities plus equity differ by ${formatAmount(report.difference.abs())}. If this report is for one branch, an entry may have been split across branches; otherwise please report it.`],
  };
}

/** A balance the way a ledger shows it: the amount, then which side it is on. */
export function sidedBalance(balance: Decimal): string {
  return balance.isZero() ? "Nil" : `${formatAmount(balance.abs())} ${balance.isPositive() ? "Dr" : "Cr"}`;
}

export function generalLedgerTable(
  account: { code: string; name: string },
  opening: Decimal,
  ledger: ReturnType<typeof runningBalance>,
  filter: Pick<ReportFilter, "from" | "to">,
  cutShort: boolean,
): ReportTable {
  return {
    title: `${REPORTS["general-ledger"].title}: ${account.code} ${account.name}`,
    period: period(filter.from, filter.to),
    columns: [
      { label: "Date", numeric: false },
      { label: "Document", numeric: false },
      { label: "Description", numeric: false },
      { label: "Debit", numeric: true },
      { label: "Credit", numeric: true },
      { label: "Balance", numeric: false },
    ],
    rows: [
      { kind: "total", depth: 0, cells: ["", "", "Opening balance", null, null, sidedBalance(opening)] },
      ...ledger.lines.map((line): ReportRow => ({ kind: "line", depth: 0, cells: [formatIsoDate(line.date), line.reference, line.description, blankIfZero(line.debit), blankIfZero(line.credit), sidedBalance(line.balance)] })),
      { kind: "grand", depth: 0, cells: ["", "", cutShort ? "Total of the entries shown" : "Closing balance", ledger.debit, ledger.credit, sidedBalance(ledger.closing)] },
    ],
    notes: cutShort ? ["This account has more entries in the period than one page shows. Choose a shorter period, or download the file, which holds them all; the opening balance always takes the earlier entries into account."] : [],
  };
}

// ── A table as a file ───────────────────────────────────────────────────────────────────────────

/**
 * The table as CSV text: a title line, the period, the headings, then the rows. Amounts are
 * plain numbers with no grouping and every decimal the books hold, so a spreadsheet reads them
 * as numbers and adds them to the same totals. A cell that could be
 * read as a formula is written as text.
 */
export function tableToCsv(table: ReportTable, company: string): string {
  const cell = (value: Cell): string => {
    if (value === null) return "";
    // Every decimal the books hold, and never fewer than two: the rows of a file add up to its totals.
    if (typeof value !== "string") return value.toFixed(4).replace(/0{1,2}$/, "");
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [[company], [table.title], [table.period], [], table.columns.map((column) => column.label), ...table.rows.map((row) => row.cells), ...table.notes.map((note) => [note])];
  return `\ufeff${lines.map((line) => line.map((value) => cell(value)).join(",")).join("\r\n")}\r\n`;
}
