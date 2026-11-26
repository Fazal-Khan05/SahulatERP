import Decimal from "decimal.js";
import { importStatement, matchByHand } from "@/modules/bank-reconciliation/commands";
import { getReconciliationPage } from "@/modules/bank-reconciliation/queries";
import { recordDailyExpense } from "@/modules/daily-expenses/commands";
import { getDailyChoices } from "@/modules/daily-expenses/queries";
import type { Demo } from "../world";

// The bank's statement for the two months, made from what the books really hold of the bank
// account: every entry the bank would have shown by now, each on its own day; the two newest
// entries left out, as cheques not yet presented; and two lines only the bank knows of, its
// charges (entered in the books afterwards and matched by hand) and a deposit nobody has
// recorded yet.

export async function seedReconciliation(d: Demo): Promise<void> {
  const { accountant, owner, yesterday, shift } = d;
  const before = (await getReconciliationPage(owner, d.bank))!;
  const inBooks = [...before.bookLines].sort((a, b) => a.date.localeCompare(b.date));
  const shown = inBooks.slice(0, Math.max(0, inBooks.length - 2));
  const cell = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const dayFirst = (iso: string) => iso.split("-").reverse().join("/");
  type Row = { date: string; description: string; amount: Decimal };
  const rows: Row[] = shown.map((line, index) => {
    // The bank shows most things the same day, a cheque a day or two later; never a day that has not come.
    const later = shift(line.date, line.amount.isNegative() && line.chequeNumber ? 1 + (index % 2) : 0);
    const words = line.amount.isNegative() ? "Paid" : "Received";
    return { date: later > yesterday ? yesterday : later, description: `${words} ${line.chequeNumber ?? ""} ${line.documentNumber ?? ""} ${line.description}`.replace(/\s+/g, " ").trim().slice(0, 90), amount: line.amount };
  });
  rows.push({ date: yesterday, description: "Bank charges cheque book and SMS alerts", amount: new Decimal("-350") });
  rows.push({ date: yesterday, description: "IBFT from MODEL TOWN MOTORS", amount: new Decimal("25000") });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const closing = rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
  const csv = [
    "Date,Description,Debit,Credit,Balance",
    `${dayFirst(d.lastMonth)},Opening Balance,,,0.00`,
    ...rows.map((row) => `${dayFirst(row.date)},${cell(row.description)},${row.amount.isNegative() ? row.amount.neg().toFixed(2) : ""},${row.amount.isNegative() ? "" : row.amount.toFixed(2)},`),
    `${dayFirst(yesterday)},Closing balance,,,${closing.toFixed(2)}`,
    "",
  ].join("\n");
  const outcome = await importStatement(accountant, d.bank, { name: "meezan-statement.csv", text: csv }, "auto");
  if ("problems" in outcome) throw new Error(`The bank statement could not be imported: ${outcome.problems.join(" ")}`);

  // The bank's charges are entered in the books and matched with the statement's line by hand.
  const charges = (await getDailyChoices(owner)).expenseAccounts.find((account) => account.name === "Bank charges");
  if (!charges) throw new Error('The demo\'s chart has no expense account called "Bank charges".');
  const entered = await recordDailyExpense(accountant, { date: yesterday, whatForId: charges.id, amount: "350", paidFromId: d.bank, paidTo: "Meezan Bank", note: "Cheque book and SMS alerts" });
  const page = (await getReconciliationPage(owner, d.bank))!;
  const bankLine = page.bankLines.find((line) => line.description.startsWith("Bank charges"));
  const bookLine = page.bookLines.find((line) => line.documentNumber === entered.number);
  if (bankLine && bookLine) await matchByHand(accountant, d.bank, [bankLine.id], [bookLine.id]);
  const after = (await getReconciliationPage(owner, d.bank))!;

  Object.assign(d.facts, { statementLines: String(outcome.lines), statementMatched: String(after.matches.length), bankOnly: String(after.bankLines.length), booksOnly: String(after.bookLines.length), bankCharges: entered.number });
  d.said.push(`Bank reconciliation: a statement of ${outcome.lines} lines imported, ${after.matches.length} matched with the books; ${after.bankLines.length} on the statement and ${after.bookLines.length} in the books are still to be matched.`);
}
