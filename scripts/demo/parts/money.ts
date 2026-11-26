import { addCashBankAccount, recordExpense, recordTransfer, saveBankDetails } from "@/modules/cash-bank/commands";
import { recordDailyExpense } from "@/modules/daily-expenses/commands";
import { getDailyChoices } from "@/modules/daily-expenses/queries";
import { postManualJournal, reverseManualJournal, saveDraft } from "@/modules/manual-journals/commands";
import { addOpenDocument, postOpening, setAccountBalance, startOpening } from "@/modules/opening/commands";
import { accountId, type Demo } from "../world";

// Money: what the company held and owed when it started using the app, the owner's capital paid
// into the bank, petty cash and transfers, two months of daily expenses (today's among them),
// and journals written by hand: one for depreciation, one entered by mistake and reversed.

export async function seedOpening(d: Demo): Promise<void> {
  const { owner, accountant, lastMonth, shift } = d;
  await startOpening(owner, { date: lastMonth });
  const debit = async (code: string, amount: string) => setAccountBalance(accountant, { accountId: await accountId(d, code), debit: amount, credit: "" });
  const credit = async (code: string, amount: string) => setAccountBalance(accountant, { accountId: await accountId(d, code), debit: "", credit: amount });
  await debit("1111", "150000");
  await debit("1510", "380000");
  await debit("1520", "265000");
  await debit("1530", "1450000");
  await credit("1590", "412000");
  await credit("2520", "600000");
  await credit("3100", "1500000");
  // An invoice and a bill from before the books were opened here, both still unpaid.
  await addOpenDocument(accountant, "receivable", { party: "C-010", documentNumber: "INV-0388", documentDate: shift(lastMonth, -45), dueDate: shift(lastMonth, -15), amount: "64500" });
  await addOpenDocument(accountant, "payable", { party: "S-002", documentNumber: "RTT-INV-2101", documentDate: shift(lastMonth, -20), dueDate: shift(lastMonth, -5), amount: "38900" });
  await postOpening(owner);
  d.said.push("Opening balances: cash, furniture, equipment and a vehicle, a director's loan, the owner's capital, one unpaid invoice and one unpaid bill from before the books were opened.");
}

export async function seedMoney(d: Demo): Promise<void> {
  const { owner, accountant, day, lastMonth, thisMonth, shift, today } = d;
  await saveBankDetails(owner, d.bank, { bankName: "Meezan Bank", accountNumber: "0101 0104471239" });
  d.petty = (await addCashBankAccount(accountant, { kind: "cash", name: "Petty cash" })).id;

  // ── Journals written by hand ────────────────────────────────────────────────────────────────
  const line = async (code: string | null, debit: string, credit: string, description: string, id?: string) => ({ accountId: id ?? (await accountId(d, code!)), description, debit, credit });
  const capital = await saveDraft(owner, null, { date: lastMonth, memo: "Capital paid into the bank by the owner", branchId: "", lines: [await line(null, "3000000", "", "Paid in by the owner", d.bank), await line("3100", "", "3000000", "Owner's capital")] });
  const capitalNumber = (await postManualJournal(owner, capital.id)).number;
  const monthEnd = shift(thisMonth, -1);
  const wear = await saveDraft(accountant, null, { date: monthEnd, memo: "Depreciation for the month", branchId: "", lines: [await line("5320", "14500", "", "Furniture, equipment and the delivery van"), await line("1590", "", "14500", "Depreciation for the month")] });
  const wearNumber = (await postManualJournal(accountant, wear.id)).number;
  const twice = await saveDraft(accountant, null, { date: day(1, 5), memo: "Rent for the month, accrued", branchId: "", lines: [await line("5230", "85000", "", "Warehouse rent"), await line("2140", "", "85000", "Rent owed to the landlord")] });
  const twiceNumber = (await postManualJournal(accountant, twice.id)).number;
  // The rent was then paid from the bank as a daily expense, so the accrual is taken back.
  await reverseManualJournal(owner, twice.id, { date: day(1, 6) });
  await saveDraft(accountant, null, { date: d.yesterday, memo: "Insurance paid for the year, to spread over the months", branchId: "", lines: [await line("1220", "96000", "", "Insurance paid in advance")] });

  // ── Transfers between the company's own accounts ────────────────────────────────────────────
  const float = await recordTransfer(accountant, { fromId: d.bank, toId: d.petty, date: day(0, 2), amount: "60,000", reference: "Cheque 100225", memo: "Petty cash for the month" });
  await recordTransfer(accountant, { fromId: d.bank, toId: d.petty, date: day(1, 2), amount: "60,000", reference: "Cheque 100251", memo: "Petty cash for the month" });
  const deposit = await recordTransfer(owner, { fromId: d.cash, toId: d.bank, date: day(1, 11), amount: "120,000", reference: "Deposit slip 55102", memo: "Cash banked" });

  // ── Daily expenses: two months, a few each week ─────────────────────────────────────────────
  const choices = await getDailyChoices(owner);
  const charged = (name: string) => {
    const found = choices.expenseAccounts.find((account) => account.name === name);
    if (!found) throw new Error(`The demo's chart has no expense account called "${name}".`);
    return found.id;
  };
  // month, day of the month, what for, amount, paid from, paid to, note
  type Entry = [0 | 1, number, string, string, "petty" | "bank" | "cash", string, string];
  const ENTRIES: Entry[] = [
    [0, 1, "Rent", "85000", "bank", "Landlord, Plot 14-C SITE", "Warehouse rent for the month"],
    [0, 2, "Entertainment", "650", "petty", "", "Tea and biscuits for the office"],
    [0, 3, "Travelling and conveyance", "3200", "petty", "Shell, Shahrah-e-Faisal", "Petrol for the delivery van"],
    [0, 5, "Freight and cartage outward", "1800", "petty", "", "Rickshaw to the transport adda"],
    [0, 8, "Printing and stationery", "2350", "petty", "Saddar Stationers", "Invoice books and markers"],
    [0, 9, "Entertainment", "480", "petty", "", "Tea for the office"],
    [0, 11, "Electricity, gas and water", "38400", "bank", "K-Electric", "Electricity bill for the warehouse"],
    [0, 12, "Travelling and conveyance", "2900", "petty", "", "Petrol for the delivery van"],
    [0, 15, "Telephone and internet", "6500", "bank", "Internet provider", "Internet for the month"],
    [0, 16, "Freight and cartage outward", "4200", "petty", "Mazda adda, Lea Market", "Loading for Hyderabad"],
    [0, 18, "Repairs and maintenance", "5500", "petty", "", "Shutter repair, Karachi warehouse"],
    [0, 20, "Entertainment", "1250", "petty", "", "Lunch for the customers from Hyderabad"],
    [0, 23, "Travelling and conveyance", "3100", "petty", "", "Petrol for the delivery van"],
    [0, 26, "Miscellaneous expenses", "900", "petty", "", "Drinking water bottles"],
    [1, 1, "Rent", "85000", "bank", "Landlord, Plot 14-C SITE", "Warehouse rent for the month"],
    [1, 2, "Entertainment", "700", "petty", "", "Tea and biscuits for the office"],
    [1, 3, "Travelling and conveyance", "3400", "petty", "Shell, Shahrah-e-Faisal", "Petrol for the delivery van"],
    [1, 5, "Freight and cartage outward", "2600", "petty", "", "Rickshaw and loading"],
    [1, 7, "Electricity, gas and water", "41250", "bank", "K-Electric", "Electricity bill for the warehouse"],
    [1, 8, "Printing and stationery", "1450", "petty", "", "Printer paper"],
    [1, 10, "Travelling and conveyance", "2800", "petty", "", "Petrol for the delivery van"],
    [1, 12, "Telephone and internet", "6500", "bank", "Internet provider", "Internet for the month"],
    [1, 13, "Repairs and maintenance", "3800", "petty", "", "Tube lights for the Lahore shop"],
    [1, 15, "Entertainment", "560", "petty", "", "Tea for the office"],
    [1, 17, "Freight and cartage outward", "3900", "petty", "Mazda adda, Lea Market", "Loading for Lahore"],
    [1, 19, "Travelling and conveyance", "3050", "petty", "", "Petrol for the delivery van"],
    [1, 22, "Miscellaneous expenses", "1100", "petty", "", "Cleaning supplies"],
  ];
  const paidFrom = { petty: d.petty, bank: d.bank, cash: d.cash };
  for (const [month, n, whatFor, amount, from, paidTo, note] of ENTRIES) {
    await recordDailyExpense(month === 0 ? accountant : owner, { date: day(month, n), whatForId: charged(whatFor), amount, paidFromId: paidFrom[from], paidTo, note });
  }
  // Today's, so the Daily expenses screen opens with something on it.
  const tea = await recordDailyExpense(owner, { date: today, whatForId: charged("Entertainment"), amount: "450", paidFromId: d.petty, paidTo: "", note: "Tea for the office" });
  await recordDailyExpense(owner, { date: today, whatForId: charged("Freight and cartage outward"), amount: "1200", paidFromId: d.petty, paidTo: "TCS, Saddar", note: "Courier to Gujranwala Parts Centre" });
  await recordDailyExpense(accountant, { date: today, whatForId: charged("Travelling and conveyance"), amount: "3000", paidFromId: d.cash, paidTo: "", note: "Petrol for the delivery van" });

  // ── An expense on the full form: two lines, one payee, paid from the bank ───────────────────
  const printing = await recordExpense(accountant, { date: day(0, 18), accountId: d.bank, payee: "Shahrah Printers", reference: "Inv 8841", lines: [{ accountId: charged("Printing and stationery"), description: "Invoice books and letterheads", amount: "18,500" }, { accountId: charged("Printing and stationery"), description: "Visiting cards for the sales team", amount: "4,200" }] });

  Object.assign(d.facts, { capitalJournal: capitalNumber, depreciationJournal: wearNumber, reversedJournal: twiceNumber, pettyCashTransfer: float.number, cashBanked: deposit.number, todaysFirstExpense: tea.number, todaysExpenses: "4,650.00", fullExpense: printing.number });
  d.said.push(`Cash and bank: petty cash, ${float.number} and two more transfers, ${ENTRIES.length + 3} daily expenses over the two months with three today, and ${printing.number} on the full form.`);
  d.said.push(`Journals: ${capitalNumber} the owner's capital, ${wearNumber} depreciation, ${twiceNumber} entered and reversed, and one left as a draft.`);
}
