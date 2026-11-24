import Decimal from "decimal.js";
import { parseCsv } from "@/lib/csv";
import { isIsoDate } from "@/modules/currencies/rules";

// Step 42: a person's bank account, the salary bank file, loans to staff, and the year's salary
// statement (s.149). Pure rules: no database here.

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

// ── IBANs ───────────────────────────────────────────────────────────────────────────────────────

/** An IBAN as typed, without its spaces, in capitals. */
export const tidyIban = (value: unknown) => text(value).replace(/[\s-]/g, "").toUpperCase();

/**
 * Whether a Pakistani IBAN is one: PK, two check digits, the bank's four letters, sixteen digits,
 * and the check digits right (ISO 13616: the number read with its first four characters moved to
 * the end, letters as 10 to 35, leaves 1 when divided by 97).
 */
export function isPakistaniIban(iban: string): boolean {
  if (!/^PK[0-9]{2}[A-Z]{4}[0-9]{16}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const char of moved) {
    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

export type RawBankAccount = { bankName?: unknown; accountTitle?: unknown; iban?: unknown };
export type BankAccount = { bankName: string; accountTitle: string; iban: string };

export function readBankAccount(raw: RawBankAccount): { ok: true; account: BankAccount } | { ok: false; reason: string } {
  const bankName = text(raw.bankName).replace(/\s+/g, " ");
  const accountTitle = text(raw.accountTitle).replace(/\s+/g, " ");
  const iban = tidyIban(raw.iban);
  if (bankName.length < 2 || bankName.length > 80) return { ok: false, reason: "Enter the bank's name." };
  if (accountTitle.length < 2 || accountTitle.length > 80) return { ok: false, reason: "Enter the account's title, as the bank has it." };
  if (!isPakistaniIban(iban)) return { ok: false, reason: "Enter the IBAN: PK, two digits, the bank's four letters and sixteen digits, as on the bank's letter or cheque book." };
  return { ok: true, account: { bankName, accountTitle, iban } };
}

// ── The salary bank file ────────────────────────────────────────────────────────────────────────

/**
 * The bank's bulk payment file, one line for each person paid: a CSV with a heading row and these
 * columns. The layout a bank was asked to accept is the founder's to send (docs/later/step-42.md);
 * until then this one, with every field the banks' bulk transfers ask for.
 */
export const BANK_FILE_COLUMNS = ["Sr No", "Beneficiary IBAN", "Beneficiary Name", "Amount", "Payment Reference"] as const;
const NAME_LENGTH = 35;
const REFERENCE_LENGTH = 30;

/** A name as a bank file may carry it: letters, digits, spaces, dots and dashes, at most 35. */
export const bankName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 .-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_LENGTH)
    .toUpperCase();

export type BankFileRow = { iban: string; name: string; amount: Decimal; reference: string };

const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** The file's text: the heading, then one line for each person, amounts to the paisa. */
export function bankFile(rows: readonly BankFileRow[]): string {
  const lines = [BANK_FILE_COLUMNS.join(",")];
  rows.forEach((row, index) => {
    lines.push([String(index + 1), row.iban, bankName(row.name), row.amount.toFixed(2), row.reference.slice(0, REFERENCE_LENGTH).toUpperCase()].map(cell).join(","));
  });
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * What is wrong with a bank file, line by line, or nothing: the heading as above; numbered from 1;
 * a Pakistani IBAN whose check digits are right; a name of letters, digits, spaces, dots and
 * dashes, at most 35; an amount above nil to the paisa; a reference of at most 30; an IBAN once.
 */
export function checkBankFile(csv: string): string[] {
  const parsed = parseCsv(csv);
  if (!parsed.ok) return [parsed.reason];
  const rows = parsed.rows.filter((r) => !(r.length === 1 && r[0] === ""));
  const problems: string[] = [];
  if (rows.length === 0 || rows[0].join(",") !== BANK_FILE_COLUMNS.join(",")) return [`The heading must be: ${BANK_FILE_COLUMNS.join(",")}`];
  const seen = new Set<string>();
  rows.slice(1).forEach((r, index) => {
    const line = index + 2;
    if (r.length !== BANK_FILE_COLUMNS.length) return void problems.push(`Line ${line}: ${BANK_FILE_COLUMNS.length} fields are needed.`);
    const [no, iban, name, amount, reference] = r;
    if (no !== String(index + 1)) problems.push(`Line ${line}: numbered ${no}, not ${index + 1}.`);
    if (!isPakistaniIban(iban)) problems.push(`Line ${line}: ${iban} is not an IBAN.`);
    if (seen.has(iban)) problems.push(`Line ${line}: ${iban} is paid twice.`);
    seen.add(iban);
    if (!/^[A-Z0-9 .-]{1,35}$/.test(name)) problems.push(`Line ${line}: the name has characters a bank file does not take, or is longer than 35.`);
    if (!/^[0-9]{1,13}\.[0-9]{2}$/.test(amount) || new Decimal(amount).lte(0)) problems.push(`Line ${line}: the amount must be above nil, to the paisa, without commas.`);
    if (reference.length < 1 || reference.length > 30) problems.push(`Line ${line}: the reference must be 1 to 30 characters.`);
  });
  if (rows.length === 1) problems.push("The file pays nobody.");
  return problems;
}

// ── Loans ───────────────────────────────────────────────────────────────────────────────────────

const amountOf = (value: unknown): Decimal | null => {
  const typed = text(value).replace(/,/g, "");
  return /^\d{1,12}(\.\d{1,2})?$/.test(typed) && new Decimal(typed).gt(0) ? new Decimal(typed) : null;
};

export type RawLoan = { employeeId?: unknown; date?: unknown; amount?: unknown; instalment?: unknown; accountId?: unknown; note?: unknown };
export type Loan = { employeeId: string; date: string; amount: Decimal; instalment: Decimal; accountId: string; note: string | null };

export function readLoan(raw: RawLoan, today: string): { ok: true; loan: Loan } | { ok: false; reason: string } {
  if (typeof raw.employeeId !== "string" || raw.employeeId === "") return { ok: false, reason: "Choose who the loan is for." };
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the day the loan is paid." };
  if (raw.date > today) return { ok: false, reason: "That day has not come yet. Nothing is recorded before it happens." };
  const amount = amountOf(raw.amount);
  if (!amount) return { ok: false, reason: "Enter the loan's amount, in rupees and paisa." };
  const instalment = amountOf(raw.instalment);
  if (!instalment) return { ok: false, reason: "Enter what comes off each month's pay." };
  if (instalment.gt(amount)) return { ok: false, reason: "The instalment cannot be more than the loan." };
  if (typeof raw.accountId !== "string" || raw.accountId === "") return { ok: false, reason: "Choose the cash or bank account the loan is paid from." };
  const note = text(raw.note).replace(/\s+/g, " ");
  if (note.length > 300) return { ok: false, reason: "Note: use at most 300 characters." };
  return { ok: true, loan: { employeeId: raw.employeeId, date: raw.date, amount, instalment, accountId: raw.accountId, note: note === "" ? null : note } };
}

export function readRepayment(raw: { date?: unknown; amount?: unknown; accountId?: unknown }, today: string): { ok: true; date: string; amount: Decimal; accountId: string } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the day it was repaid." };
  if (raw.date > today) return { ok: false, reason: "That day has not come yet. Nothing is recorded before it happens." };
  const amount = amountOf(raw.amount);
  if (!amount) return { ok: false, reason: "Enter what was repaid, in rupees and paisa." };
  if (typeof raw.accountId !== "string" || raw.accountId === "") return { ok: false, reason: "Choose the cash or bank account it was paid into." };
  return { ok: true, date: raw.date, amount, accountId: raw.accountId };
}

// ── The year's salary statement (s.149) ─────────────────────────────────────────────────────────

/** One person's year: what they were paid, what of it was taxable, and the tax deducted (their approved payslips). */
export type AnnualRow = { code: string; name: string; cnic: string | null; months: number; pay: Decimal; taxable: Decimal; tax: Decimal };

/** The tax year a July starts, as FBR writes it: Tax Year 2027 for July 2026 to June 2027. */
export const taxYearName = (julyOf: number) => `Tax Year ${julyOf + 1}`;

/** The statement as CSV: a heading, one line a person, and the totals. */
export function annualStatementCsv(rows: readonly AnnualRow[], julyOf: number): string {
  const total = (pick: (row: AnnualRow) => Decimal) => rows.reduce((t, row) => t.plus(pick(row)), new Decimal(0)).toFixed(2);
  const lines = [
    [`Salary paid and income tax deducted (s.149), ${taxYearName(julyOf)}: 1 July ${julyOf} to 30 June ${julyOf + 1}`],
    ["Code", "Name", "CNIC", "Months paid", "Pay and commission", "Taxable salary", "Income tax deducted"],
    ...rows.map((row) => [row.code, row.name, row.cnic ?? "", String(row.months), row.pay.toFixed(2), row.taxable.toFixed(2), row.tax.toFixed(2)]),
    ["", "Total", "", "", total((r) => r.pay), total((r) => r.taxable), total((r) => r.tax)],
  ];
  // A cell that would start a formula in a spreadsheet is written as text.
  const safe = (value: string) => (/^[=+\-@]/.test(value) ? `'${value}` : value);
  return `${lines.map((line) => line.map((value) => cell(safe(value))).join(",")).join("\r\n")}\r\n`;
}
