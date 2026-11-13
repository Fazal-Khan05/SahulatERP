import Decimal from "decimal.js";
import { AMOUNT_SCALE, formatAmount } from "@/lib/money";
import { cleanText } from "@/lib/text";
import type { MemberRole } from "@/modules/tenant/rules";

// Pure rules for the chart of accounts. No I/O.
//
// The chart is a tree. A heading holds other accounts and is never posted to; an account that is
// not a heading is what a journal line names. The accounts the product relies on are locked: the
// company cannot rename, archive or delete them. Everything else is the company's own.

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

/**
 * What a locked account is for. A posting finds its account by one of these, never by a code or
 * a name. `bank` and `cash` sit on a heading and on every account the company adds beneath it.
 */
export const CONTROL_TYPES = {
  cash: "Cash accounts",
  bank: "Bank accounts",
  cheques_in_hand: "Cheques in hand",
  ar: "Trade receivables",
  supplier_advances: "Advances to suppliers",
  inventory: "Stock in trade",
  goods_in_transit: "Goods in transit",
  input_tax: "Sales tax receivable (input tax)",
  advance_income_tax: "Advance income tax",
  ap: "Trade payables",
  grni: "Goods received not invoiced",
  customer_advances: "Advances from customers",
  output_tax: "Sales tax payable (output tax)",
  wht_income_tax: "Income tax withheld payable",
  wht_sales_tax: "Sales tax withheld payable",
  wht_provincial_tax: "Provincial sales tax withheld payable",
  payroll_payable: "Salaries payable",
  payroll_statutory_payable: "EOBI and social security payable",
  commission_payable: "Commission payable",
  retained_earnings: "Retained earnings",
  opening_equity: "Opening balance equity",
  sales: "Sales",
  cogs: "Cost of goods sold",
  stock_adjustment: "Stock adjustments",
  salaries_expense: "Salaries and wages",
  commission_expense: "Sales commission",
  bank_charges: "Bank charges",
  fx_gain_loss: "Exchange gain or loss",
} as const;
export type ControlType = keyof typeof CONTROL_TYPES;
export const isControlType = (value: unknown): value is ControlType => typeof value === "string" && Object.hasOwn(CONTROL_TYPES, value);

/** Accounts that exist only for sales tax. A company not registered for sales tax never sees them. */
export const SALES_TAX_CONTROLS: readonly ControlType[] = ["input_tax", "output_tax", "wht_sales_tax"];

/** How deep the tree may go below a root; the database enforces the same. */
export const MAX_DEPTH = 5;

/**
 * Why nothing of this kind can be added under a heading at `parentDepth` (a root is 0), or null
 * when it can. A heading stops one level short, so something can always sit under it.
 */
export function depthProblem(parentDepth: number, isGroup: boolean): string | null {
  if (parentDepth + 1 > MAX_DEPTH) return "The chart of accounts can be at most five levels deep. Choose a heading higher up.";
  if (isGroup && parentDepth + 1 > MAX_DEPTH - 1) return "A heading cannot sit at the deepest level, because nothing could sit under it. Add an account here, or choose a heading higher up.";
  return null;
}

export type Account = {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  type: AccountType;
  isGroup: boolean;
  isControl: boolean;
  controlType: string | null;
  archivedAt: Date | null;
  updatedAt: Date;
};

export type AccountNode = Account & { depth: number };

const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, "en", { numeric: true });

/**
 * The chart in the order it is read: each root, then everything beneath it, by code, with how
 * deep each account sits. An account whose parent is missing from the list is left out.
 */
export function chartOrder<T extends Pick<Account, "id" | "parentId" | "code">>(accounts: readonly T[]): (T & { depth: number })[] {
  const children = new Map<string | null, T[]>();
  for (const account of accounts) children.set(account.parentId, [...(children.get(account.parentId) ?? []), account]);
  const out: (T & { depth: number })[] = [];
  const walk = (parentId: string | null, depth: number) => {
    // A loop cannot be stored, but nothing here should hang if one ever were.
    if (depth > MAX_DEPTH + 1) return;
    for (const account of [...(children.get(parentId) ?? [])].sort(byCode)) {
      out.push({ ...account, depth });
      walk(account.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The chart as a company sees it: without the sales tax accounts when it is not registered. */
export function visibleAccounts<T extends Pick<Account, "controlType">>(accounts: readonly T[], salesTaxRegistered: boolean): T[] {
  if (salesTaxRegistered) return [...accounts];
  return accounts.filter((account) => !(SALES_TAX_CONTROLS as readonly string[]).includes(account.controlType ?? ""));
}

const CODE = /^[0-9A-Z][0-9A-Z.-]{0,11}$/;

/** An account code as typed: letters are made capitals. Empty when nothing usable was typed. */
export function readCode(value: unknown): { ok: true; code: string } | { ok: false; reason: string } {
  const code = cleanText(value).toUpperCase();
  if (!CODE.test(code)) return { ok: false, reason: "Code: up to 12 digits or letters, such as 5340. Dots and dashes are allowed inside." };
  return { ok: true, code };
}

export function readAccountName(value: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  const name = cleanText(value);
  if (name.length < 2 || name.length > 80) return { ok: false, reason: "Name: between 2 and 80 characters." };
  return { ok: true, name };
}

/**
 * The next free code under a parent, or null when the parent's code is not a plain number.
 * It follows the last account under the parent: under 5000 the accounts go up in hundreds, under
 * 5200 in tens, under 1120 in ones (one place smaller than the parent's own round figure). A
 * code already taken anywhere in the chart is skipped, and a suggestion never reaches `ceiling`,
 * the code of the next heading beside the parent, so it cannot land among that heading's accounts.
 */
export function suggestCode(parentCode: string, siblingCodes: readonly string[], allCodes: readonly string[], ceiling: string | null = null): string | null {
  if (!/^[1-9]\d{0,10}$/.test(parentCode)) return null;
  const taken = new Set(allCodes);
  if (!parentCode.endsWith("0")) {
    // A parent that is not a round figure has no range of its own: 5341 holds 53411, 53412, ...
    for (let n = 1; n < 100; n += 1) {
      const candidate = `${parentCode}${n}`;
      if (candidate.length <= 12 && !taken.has(candidate)) return candidate;
    }
    return null;
  }
  // A code is a label, not an amount: eleven digits fit a JS number exactly.
  const parent = Number(parentCode);
  const zeros = parentCode.length - parentCode.replace(/0+$/, "").length;
  const step = 10 ** (zeros - 1);
  // Up to the next heading beside the parent; with none, the parent's own round range (5000 holds up to 5999).
  const limit = ceiling !== null && /^\d{1,11}$/.test(ceiling) && Number(ceiling) > parent ? Number(ceiling) : parent + 10 ** zeros;
  const last = siblingCodes.filter((code) => /^\d{1,11}$/.test(code)).map(Number).reduce((max, code) => (code > max && code < limit ? code : max), parent);
  // After the last account under the heading, at the heading's own spacing.
  for (let candidate = last + step; candidate < limit; candidate += step) {
    if (!taken.has(String(candidate))) return String(candidate);
  }
  // No room there: the first gap after the heading itself.
  for (let candidate = parent + 1; candidate < Math.min(limit, parent + 1000); candidate += 1) {
    if (!taken.has(String(candidate))) return String(candidate);
  }
  return null;
}

/**
 * The code of the next heading beside `parent` in the chart: the lowest numeric code, above the
 * parent's own, among the parent's siblings and, failing that, its ancestors' siblings.
 */
export function codeCeiling(parent: Pick<Account, "id" | "parentId" | "code">, accounts: readonly Pick<Account, "id" | "parentId" | "code">[]): string | null {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const own = Number(parent.code);
  if (!Number.isFinite(own)) return null;
  for (let at: Pick<Account, "id" | "parentId" | "code"> | undefined = parent, hops = 0; at && hops <= MAX_DEPTH; at = at.parentId ? byId.get(at.parentId) : undefined, hops += 1) {
    const here = at;
    const beside = accounts
      .filter((account) => account.parentId === here.parentId && account.id !== here.id && /^\d{1,11}$/.test(account.code) && Number(account.code) > own)
      .map((account) => Number(account.code));
    if (beside.length > 0) return String(Math.min(...beside));
  }
  return null;
}

export type NewAccount = { parentId: string; name: string; code: string | null; isGroup: boolean };

/** Cleans what was typed for a new account, or says what is wrong. An empty code means "the next free one". */
export function readNewAccount(raw: { parentId?: unknown; name?: unknown; code?: unknown; kind?: unknown }): { ok: true; account: NewAccount } | { ok: false; reason: string } {
  const parentId = typeof raw.parentId === "string" ? raw.parentId.trim() : "";
  if (parentId === "") return { ok: false, reason: "Choose the heading the account sits under." };
  const name = readAccountName(raw.name);
  if (!name.ok) return name;
  let code: string | null = null;
  if (cleanText(raw.code) !== "") {
    const read = readCode(raw.code);
    if (!read.ok) return read;
    code = read.code;
  }
  if (raw.kind !== "account" && raw.kind !== "heading") return { ok: false, reason: "Say whether this is an account or a heading." };
  return { ok: true, account: { parentId, name: name.name, code, isGroup: raw.kind === "heading" } };
}

/** Why the company cannot change this account, or null when it can. */
export function lockedReason(account: Pick<Account, "isControl">): string | null {
  return account.isControl ? "This account is part of the starting chart and is locked: the product relies on it." : null;
}

// ── Posting ─────────────────────────────────────────────────────────────────────────────────────
//
// A journal is a set of lines whose debits equal its credits, posted for one source document.
// checkJournalLines() says whether a set of lines can be a journal; the database checks the same
// again, whoever writes the rows.

/**
 * Accounts that must always agree with something kept elsewhere: each customer's and supplier's
 * balance, the stock records, the cheques on hand. Only the documents that keep those records
 * may post to them; a manual journal may not.
 */
export const SUBLEDGER_CONTROLS = ["ar", "ap", "inventory", "customer_advances", "supplier_advances", "grni", "goods_in_transit", "cheques_in_hand"] as const satisfies readonly ControlType[];
/** Accounts whose every line names a customer, and those whose every line names a supplier. */
export const CUSTOMER_CONTROLS = ["ar", "customer_advances"] as const satisfies readonly ControlType[];
export const SUPPLIER_CONTROLS = ["ap", "supplier_advances"] as const satisfies readonly ControlType[];

/**
 * The kinds of document that post a journal, who may post each, who may reverse its journal
 * directly (nobody, for a document that must be cancelled through its own command), and the
 * accounts each may not touch. The database holds the same list (app.journal_source_roles,
 * app.journal_source_reversal_roles and app.journal_source_blocked_controls); a step that adds a
 * kind adds it in both.
 */
export const JOURNAL_SOURCES = {
  manual_journal: { label: "Manual journal", roles: ["owner", "accountant"], reversalRoles: ["owner", "accountant"], blockedControls: SUBLEDGER_CONTROLS },
  // Receivables and payables are open to it: each of its lines there names the customer or the supplier.
  opening_balance: {
    label: "Opening balances",
    roles: ["owner", "accountant"],
    reversalRoles: ["owner", "accountant"],
    blockedControls: ["inventory", "customer_advances", "supplier_advances", "grni", "goods_in_transit", "cheques_in_hand"],
  },
} as const satisfies Record<string, { label: string; roles: readonly MemberRole[]; reversalRoles: readonly MemberRole[]; blockedControls: readonly ControlType[] }>;
export type JournalSourceType = keyof typeof JOURNAL_SOURCES;
export const isJournalSource = (value: unknown): value is JournalSourceType => typeof value === "string" && Object.hasOwn(JOURNAL_SOURCES, value);

export const MAX_JOURNAL_LINES = 1000;
/** The columns are numeric(20,4): sixteen digits before the point. */
const AMOUNT_LIMIT = new Decimal("1e16");
/** decimal.js keeps 20 significant digits by default; a sum of large amounts needs more. */
const Exact = Decimal.clone({ precision: 60 });

export type JournalLineInput = {
  accountId: string;
  /** Exactly one of debit and credit is above zero. */
  debit?: Decimal | null;
  credit?: Decimal | null;
  description?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
};

export const MAX_LINE_DESCRIPTION = 300;
export const MAX_JOURNAL_MEMO = 500;

const amountProblem = (amount: Decimal): string | null => {
  if (!amount.isFinite() || amount.isNegative()) return "an amount cannot be negative";
  if (amount.decimalPlaces() > AMOUNT_SCALE) return `an amount has at most ${AMOUNT_SCALE} digits after the point`;
  if (amount.gte(AMOUNT_LIMIT)) return "that amount is too large";
  return null;
};

/**
 * Whether these lines can be posted as one journal: at least two lines, each a debit or a
 * credit above zero and never both, and debits equal to credits. Nothing is rounded.
 */
export function checkJournalLines(lines: readonly JournalLineInput[]): { ok: true; total: Decimal } | { ok: false; reason: string } {
  if (lines.length < 2) return { ok: false, reason: "A journal needs at least two lines: a debit and a credit." };
  if (lines.length > MAX_JOURNAL_LINES) return { ok: false, reason: `A journal can have at most ${MAX_JOURNAL_LINES} lines.` };
  let debits = new Exact(0);
  let credits = new Exact(0);
  for (const [index, line] of lines.entries()) {
    const at = `Line ${index + 1}`;
    const debit = line.debit ?? new Decimal(0);
    const credit = line.credit ?? new Decimal(0);
    const problem = amountProblem(debit) ?? amountProblem(credit);
    if (problem) return { ok: false, reason: `${at}: ${problem}.` };
    if (debit.isZero() && credit.isZero()) return { ok: false, reason: `${at}: enter a debit or a credit.` };
    if (!debit.isZero() && !credit.isZero()) return { ok: false, reason: `${at}: enter a debit or a credit, not both.` };
    if (line.customerId && line.supplierId) return { ok: false, reason: `${at}: a line belongs to a customer or to a supplier, not both.` };
    if ((line.description ?? "").length > MAX_LINE_DESCRIPTION) return { ok: false, reason: `${at}: use at most ${MAX_LINE_DESCRIPTION} characters for the description.` };
    debits = debits.plus(debit);
    credits = credits.plus(credit);
  }
  if (!debits.eq(credits)) {
    return { ok: false, reason: `The journal does not balance: debits are ${formatAmount(debits)} and credits are ${formatAmount(credits)}.` };
  }
  // Handed back as an ordinary Decimal; the wider one was only for adding up.
  return { ok: true, total: new Decimal(debits.toFixed()) };
}
