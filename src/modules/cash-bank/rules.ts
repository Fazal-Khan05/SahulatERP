import Decimal from "decimal.js";
import { isIsoDate } from "@/modules/currencies/rules";

// Step 34: what is typed for cash and bank, cleaned, or the first thing that is wrong in plain
// words; and what an expense comes to, worked out as the database works it out
// (app.record_expense in drizzle/0038_cash_bank.sql), so a form can show it before it is sent.

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const tidy = (value: unknown) => text(value).replace(/\s+/g, " ");
const paisa = (amount: Decimal) => amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Rupees and paisa as typed, commas allowed: above nothing. */
export function readRupees(input: unknown): { ok: true; amount: Decimal } | { ok: false; reason: string } {
  const typed = text(input).replace(/,/g, "");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(typed)) return { ok: false, reason: "Enter the amount in rupees, such as 5000 or 1250.50." };
  const amount = new Decimal(typed);
  if (amount.lte(0)) return { ok: false, reason: "Enter an amount above nothing." };
  return { ok: true, amount };
}

export type RawNewAccount = { kind?: unknown; name?: unknown; bankName?: unknown; accountNumber?: unknown };
export type NewAccount = { kind: "cash" | "bank"; name: string; bankName: string | null; accountNumber: string | null };

export const ACCOUNT_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{3,33}$/;

/** A new cash or bank account: petty cash is one more cash account. */
export function readNewAccount(raw: RawNewAccount): { ok: true; account: NewAccount } | { ok: false; reason: string } {
  if (raw.kind !== "cash" && raw.kind !== "bank") return { ok: false, reason: "Choose whether it is a cash account or a bank account." };
  const name = tidy(raw.name);
  if (name.length < 2 || name.length > 120) return { ok: false, reason: "Name the account, such as Petty cash or HBL current account." };
  const details = readBankDetails(raw);
  if (!details.ok) return details;
  if (raw.kind === "cash" && (details.bankName !== null || details.accountNumber !== null)) return { ok: false, reason: "A cash account has no bank or account number." };
  return { ok: true, account: { kind: raw.kind, name, bankName: details.bankName, accountNumber: details.accountNumber } };
}

/** A bank account's bank and number, both optional. */
export function readBankDetails(raw: { bankName?: unknown; accountNumber?: unknown }): { ok: true; bankName: string | null; accountNumber: string | null } | { ok: false; reason: string } {
  const bankName = tidy(raw.bankName);
  if (bankName !== "" && (bankName.length < 2 || bankName.length > 80)) return { ok: false, reason: "The bank's name: from 2 to 80 characters." };
  const accountNumber = tidy(raw.accountNumber);
  if (accountNumber !== "" && !ACCOUNT_NUMBER_PATTERN.test(accountNumber)) return { ok: false, reason: "Enter the account number or IBAN as letters and digits, such as PK36SCBL0000001123456702." };
  return { ok: true, bankName: bankName === "" ? null : bankName, accountNumber: accountNumber === "" ? null : accountNumber };
}

export type RawTransfer = { fromId?: unknown; toId?: unknown; date?: unknown; amount?: unknown; reference?: unknown; memo?: unknown };
export type Transfer = { fromId: string; toId: string; date: string; amount: Decimal; reference: string | null; memo: string | null };

export function readTransfer(raw: RawTransfer, today: string): { ok: true; transfer: Transfer } | { ok: false; reason: string } {
  const fromId = text(raw.fromId);
  const toId = text(raw.toId);
  if (fromId === "") return { ok: false, reason: "Choose the account the money leaves." };
  if (toId === "") return { ok: false, reason: "Choose the account the money goes to." };
  if (fromId === toId) return { ok: false, reason: "Money is moved between two different accounts." };
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date." };
  if (raw.date > today) return { ok: false, reason: "That date has not come yet." };
  const amount = readRupees(raw.amount);
  if (!amount.ok) return amount;
  const reference = tidy(raw.reference);
  if (reference.length > 60) return { ok: false, reason: "The reference: use at most 60 characters." };
  const memo = tidy(raw.memo);
  if (memo.length > 300) return { ok: false, reason: "The note: use at most 300 characters." };
  return { ok: true, transfer: { fromId, toId, date: raw.date, amount: amount.amount, reference: reference || null, memo: memo || null } };
}

export const MAX_EXPENSE_LINES = 50;

export type RawExpense = {
  date?: unknown;
  accountId?: unknown;
  supplierId?: unknown;
  payee?: unknown;
  branchId?: unknown;
  reference?: unknown;
  memo?: unknown;
  incomeTaxCode?: unknown;
  provincialTaxCode?: unknown;
  /** One entry per row of the form; rows left wholly empty are skipped and not counted. */
  lines?: readonly { accountId?: unknown; description?: unknown; amount?: unknown }[];
};
export type ExpenseLine = { accountId: string; description: string; amount: Decimal };
export type Expense = {
  date: string;
  accountId: string;
  supplierId: string | null;
  payee: string | null;
  branchId: string | null;
  reference: string | null;
  memo: string | null;
  incomeTaxCode: string | null;
  provincialTaxCode: string | null;
  lines: ExpenseLine[];
};

export function readExpense(raw: RawExpense, today: string): { ok: true; expense: Expense } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date." };
  if (raw.date > today) return { ok: false, reason: "That date has not come yet." };
  const accountId = text(raw.accountId);
  if (accountId === "") return { ok: false, reason: "Choose the cash or bank account the money left." };
  const supplierId = text(raw.supplierId);
  const payee = tidy(raw.payee);
  if (supplierId === "" && payee === "") return { ok: false, reason: "Choose the supplier, or name who was paid." };
  if (supplierId !== "" && payee !== "") return { ok: false, reason: "Choose the supplier or name who was paid, not both." };
  if (payee !== "" && (payee.length < 2 || payee.length > 120)) return { ok: false, reason: "Name who was paid: from 2 to 120 characters." };
  const incomeTaxCode = text(raw.incomeTaxCode);
  const provincialTaxCode = text(raw.provincialTaxCode);
  if ((incomeTaxCode !== "" || provincialTaxCode !== "") && supplierId === "") return { ok: false, reason: "Tax is withheld from a supplier on the list: choose the supplier." };
  const reference = tidy(raw.reference);
  if (reference.length > 60) return { ok: false, reason: "The reference: use at most 60 characters." };
  const memo = tidy(raw.memo);
  if (memo.length > 300) return { ok: false, reason: "The note: use at most 300 characters." };
  const lines: ExpenseLine[] = [];
  for (const row of raw.lines ?? []) {
    const lineAccount = text(row.accountId);
    const description = tidy(row.description);
    const typed = text(row.amount);
    if (lineAccount === "" && description === "" && typed === "") continue;
    const at = `Line ${lines.length + 1}`;
    if (lineAccount === "") return { ok: false, reason: `${at}: choose the account it is charged to.` };
    if (description.length < 2 || description.length > 200) return { ok: false, reason: `${at}: say what it was for.` };
    const amount = readRupees(typed);
    if (!amount.ok) return { ok: false, reason: `${at}: ${amount.reason}` };
    lines.push({ accountId: lineAccount, description, amount: amount.amount });
  }
  if (lines.length === 0) return { ok: false, reason: "Enter at least one line: what the money was spent on." };
  if (lines.length > MAX_EXPENSE_LINES) return { ok: false, reason: `An expense has at most ${MAX_EXPENSE_LINES} lines.` };
  const branchId = text(raw.branchId);
  return {
    ok: true,
    expense: {
      date: raw.date,
      accountId,
      supplierId: supplierId || null,
      payee: payee || null,
      branchId: branchId || null,
      reference: reference || null,
      memo: memo || null,
      incomeTaxCode: incomeTaxCode || null,
      provincialTaxCode: provincialTaxCode || null,
      lines,
    },
  };
}

export type RawCancel = { date?: unknown; reason?: unknown };

export function readCancel(raw: RawCancel, today: string): { ok: true; date: string; reason: string } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date it is cancelled on." };
  if (raw.date > today) return { ok: false, reason: "That date has not come yet." };
  const reason = tidy(raw.reason);
  if (reason.length < 3 || reason.length > 300) return { ok: false, reason: "Say why it is cancelled." };
  return { ok: true, date: raw.date, reason };
}

/** A withholding line as the tables hold it on the day: its rate, the rate for a supplier not on the Active Taxpayers List, and what it is worked out on. */
export type RuleOnDay = { rate: Decimal; rateNonAtl: Decimal | null; base: "gross_amount" | "taxable_value" | "sales_tax" };

export type ExpenseFigures = {
  amount: Decimal;
  provincial: Decimal;
  total: Decimal;
  incomeTax: Decimal;
  withheld: Decimal;
  paid: Decimal;
  /** Each line's share of the province's tax: rounded down to paisa, the paisa left over going one each to the lines with the largest part cut off. */
  shares: Decimal[];
};

/**
 * What an expense comes to, as the database works it out: the province's tax on the lines at its
 * rate, added to them and withheld whole; income tax at the supplier's rate on the gross (or on
 * the lines, as the line of the tables says); what is left is what is paid. Null when the income
 * tax line is not one an expense is withheld under.
 */
export function figureExpense(amounts: readonly Decimal[], provincialRate: Decimal | null, incomeTax: RuleOnDay | null, onActiveList: boolean): ExpenseFigures | null {
  const amount = amounts.reduce((sum, a) => sum.plus(a), new Decimal(0));
  const provincial = provincialRate === null ? new Decimal(0) : paisa(amount.times(provincialRate).div(100));
  const total = amount.plus(provincial);
  let tax = new Decimal(0);
  if (incomeTax) {
    const rate = onActiveList ? incomeTax.rate : (incomeTax.rateNonAtl ?? incomeTax.rate);
    const base = incomeTax.base === "gross_amount" ? total : incomeTax.base === "taxable_value" ? amount : null;
    if (base === null || rate.lte(0)) return null;
    tax = paisa(base.times(rate).div(100));
  }
  const withheld = provincial.plus(tax);
  return { amount, provincial, total, incomeTax: tax, withheld, paid: total.minus(withheld), shares: shareOut(provincial, amounts) };
}

/**
 * The province's tax shared over the lines in proportion: each share rounded down to paisa, and
 * the paisa left over given one each to the lines with the largest part cut off, the first of
 * equals first. No share is ever below nil, and they always add up to the tax.
 */
export function shareOut(tax: Decimal, amounts: readonly Decimal[]): Decimal[] {
  const amount = amounts.reduce((sum, a) => sum.plus(a), new Decimal(0));
  if (tax.isZero() || amount.isZero()) return amounts.map(() => new Decimal(0));
  const exact = amounts.map((a) => tax.times(a).times(100).div(amount));
  const cents = exact.map((e) => e.floor());
  let spare = tax.times(100).round().minus(cents.reduce((sum, c) => sum.plus(c), new Decimal(0))).toNumber();
  const order = exact.map((e, index) => ({ index, cut: e.minus(e.floor()) })).sort((a, b) => b.cut.comparedTo(a.cut) || a.index - b.index);
  for (const { index } of order) {
    if (spare <= 0) break;
    cents[index] = cents[index].plus(1);
    spare -= 1;
  }
  return cents.map((c) => c.div(100));
}

