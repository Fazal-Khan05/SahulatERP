import Decimal from "decimal.js";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { parseQuantity } from "@/modules/items/rules";
import { parseUnitCost } from "@/modules/purchasing/rules";
import { taxRateOn, withholdingRateFor, withholdingRuleOn, type TaxCategoryKind, type WithholdingBase, type WithholdingKind } from "@/modules/tax/rules";

// Pure rules for a supplier's bill. No I/O.
//
// A bill is typed as a supplier, a branch, the supplier's own invoice number and date, and
// lines: goods already received (so much of one line of a goods received note, at the
// supplier's price) or an expense or service (an amount charged to an account). Every rate
// comes from the dated tax tables the caller hands in, through src/modules/tax/rules.ts: none
// is ever typed. The database works the same figures out again when the bill is posted, and
// refuses a bill whose figures differ. Everything is decimal.js.

export const BILL_STATUSES = ["draft", "posted"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];
export const BILL_STATUS_LABELS: Record<BillStatus, string> = { draft: "Draft", posted: "Posted" };

/** A bill typed by hand can hold this many lines. */
export const MAX_BILL_LINES = 200;

const NIL = new Decimal(0);
const paisa = (amount: Decimal) => amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const CODE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** An amount of money as typed: a plain number above nothing, to the paisa. */
export function parseBillAmount(input: unknown): { ok: true; amount: Decimal } | { ok: false; reason: string } {
  const typed = text(input);
  if (typed === "") return { ok: false, reason: "Enter the amount." };
  if (!/^\d+(\.\d+)?$/.test(typed)) return { ok: false, reason: "Enter the amount as a plain number without commas, such as 1250 or 1250.50." };
  const [whole, fraction = ""] = typed.split(".");
  if (fraction.length > 2) return { ok: false, reason: "Use at most 2 digits after the point." };
  if (whole.replace(/^0+/, "").length > 13) return { ok: false, reason: "That amount is too large." };
  const amount = new Decimal(typed);
  if (amount.lte(0)) return { ok: false, reason: "The amount must be more than zero." };
  return { ok: true, amount };
}

export type RawBill = {
  date?: unknown;
  supplierId?: unknown;
  branchId?: unknown;
  supplierInvoiceNo?: unknown;
  dueDate?: unknown;
  note?: unknown;
  incomeTaxCode?: unknown;
  salesTaxCode?: unknown;
  provincialTaxCode?: unknown;
  goods?: readonly { receiptLineId?: unknown; quantity?: unknown; unitPrice?: unknown; taxCategoryId?: unknown }[];
  expenses?: readonly { accountId?: unknown; description?: unknown; amount?: unknown; taxCategoryId?: unknown }[];
};

export type BillDraftGoods = { receiptLineId: string; quantity: Decimal; unitPrice: Decimal; taxCategoryId: string | null };
export type BillDraftExpense = { accountId: string; description: string; amount: Decimal; taxCategoryId: string | null };
export type BillDraft = {
  date: string;
  supplierId: string;
  branchId: string;
  supplierInvoiceNo: string;
  dueDate: string | null;
  note: string | null;
  incomeTaxCode: string | null;
  salesTaxCode: string | null;
  provincialTaxCode: string | null;
  goods: BillDraftGoods[];
  expenses: BillDraftExpense[];
};

function readCode(input: unknown, kind: WithholdingKind): { ok: true; code: string | null } | { ok: false } {
  const typed = text(input);
  if (typed === "") return { ok: true, code: null };
  return CODE.test(typed) && typed.startsWith(`${kind}.`) && typed.length <= 80 ? { ok: true, code: typed } : { ok: false };
}

/** Cleans what was typed for a bill, or gives the first thing that is wrong in plain words. */
export function readBill(raw: RawBill): { ok: true; bill: BillDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date on the supplier's invoice." };
  const supplierId = text(raw.supplierId);
  if (supplierId === "") return { ok: false, reason: "Choose the supplier." };
  const branchId = text(raw.branchId);
  if (branchId === "") return { ok: false, reason: "Choose the branch the bill belongs to." };
  const supplierInvoiceNo = cleanText(raw.supplierInvoiceNo);
  if (supplierInvoiceNo === "") return { ok: false, reason: "Enter the number on the supplier's invoice." };
  if (supplierInvoiceNo.length > 60) return { ok: false, reason: "The supplier's invoice number: use at most 60 characters." };
  const due = text(raw.dueDate);
  if (due !== "" && !isIsoDate(due)) return { ok: false, reason: "Enter the day the bill is due, or leave it empty." };
  if (due !== "" && due < raw.date) return { ok: false, reason: "A bill cannot be due before its own date." };
  const note = cleanText(raw.note);
  if (note.length > 500) return { ok: false, reason: "Note: use at most 500 characters." };
  const income = readCode(raw.incomeTaxCode, "income_tax");
  const sales = readCode(raw.salesTaxCode, "sales_tax");
  const provincial = readCode(raw.provincialTaxCode, "provincial_sales_tax");
  if (!income.ok || !sales.ok || !provincial.ok) return { ok: false, reason: "Choose the withholding lines from the lists." };

  const goods: BillDraftGoods[] = [];
  for (const row of raw.goods ?? []) {
    const receiptLineId = text(row.receiptLineId);
    const quantity = text(row.quantity);
    if (receiptLineId === "" || quantity === "" || /^0+(\.0+)?$/.test(quantity)) continue;
    const at = `Goods, line ${goods.length + 1}`;
    const parsedQuantity = parseQuantity(quantity);
    if (!parsedQuantity.ok) return { ok: false, reason: `${at}, quantity: ${parsedQuantity.reason}` };
    const parsedPrice = parseUnitCost(row.unitPrice);
    if (!parsedPrice.ok) return { ok: false, reason: `${at}, price: ${parsedPrice.reason.replace("what one costs", "the supplier's price for one")}` };
    if (goods.some((line) => line.receiptLineId === receiptLineId)) return { ok: false, reason: "A line of goods received is on the bill twice." };
    goods.push({ receiptLineId, quantity: parsedQuantity.value, unitPrice: parsedPrice.cost, taxCategoryId: text(row.taxCategoryId) || null });
  }
  const expenses: BillDraftExpense[] = [];
  for (const row of raw.expenses ?? []) {
    const accountId = text(row.accountId);
    const amount = text(row.amount);
    const description = cleanText(row.description);
    if (accountId === "" && amount === "" && description === "") continue;
    const at = `Expenses, line ${expenses.length + 1}`;
    if (accountId === "") return { ok: false, reason: `${at}: choose the account it is charged to.` };
    if (description === "") return { ok: false, reason: `${at}: say what it is for.` };
    if (description.length > 300) return { ok: false, reason: `${at}: use at most 300 characters for what it is for.` };
    const parsed = parseBillAmount(amount);
    if (!parsed.ok) return { ok: false, reason: `${at}: ${parsed.reason}` };
    expenses.push({ accountId, description, amount: parsed.amount, taxCategoryId: text(row.taxCategoryId) || null });
  }
  if (goods.length + expenses.length > MAX_BILL_LINES) return { ok: false, reason: `A bill can have at most ${MAX_BILL_LINES} lines.` };
  return {
    ok: true,
    bill: {
      date: raw.date,
      supplierId,
      branchId,
      supplierInvoiceNo,
      dueDate: due === "" ? null : due,
      note: note === "" ? null : note,
      incomeTaxCode: income.code,
      salesTaxCode: sales.code,
      provincialTaxCode: provincial.code,
      goods,
      expenses,
    },
  };
}

// ── The figures of a bill ───────────────────────────────────────────────────────────────────────

/** A line of goods received that can be billed: what arrived, what has been billed of it, and what the order said one costs. */
export type ReceiptLineToBill = {
  receiptLineId: string;
  receiptNumber: string;
  receiptDate: string;
  orderNumber: string;
  itemId: string;
  itemCode: string;
  description: string;
  unitCode: string;
  received: Decimal;
  billed: Decimal;
  /** Sent back to the supplier before it was billed (Step 27); nothing where the field is left out. */
  returned?: Decimal;
  orderCost: Decimal;
  taxCategoryId: string | null;
};

/** How much of a received line is still to be billed: what arrived, less what was billed or sent back unbilled; never below nothing. */
export function stillToBill(line: Pick<ReceiptLineToBill, "received" | "billed" | "returned">): Decimal {
  return Decimal.max(line.received.minus(line.billed).minus(line.returned ?? 0), 0);
}

export type BillTaxTables = {
  /** The company is registered for sales tax, and so is the supplier, with an STRN: input tax can be claimed. */
  inputTaxAllowed: boolean;
  categories: ReadonlyMap<string, { kind: TaxCategoryKind }>;
  rates: readonly { categoryId: string; effectiveFrom: string; rate: Decimal }[];
};

export type FiguredLine = {
  kind: "goods" | "expense";
  receiptLineId: string | null;
  itemId: string | null;
  accountId: string | null;
  description: string;
  quantity: Decimal | null;
  unitPrice: Decimal | null;
  amount: Decimal;
  taxCategoryId: string | null;
  taxRate: Decimal | null;
  salesTax: Decimal;
};

/** The input tax on one line: its amount at the rate in force on the bill's date for its category. */
function lineTax(amount: Decimal, categoryId: string | null, date: string, tables: BillTaxTables, at: string): { ok: true; rate: Decimal | null; tax: Decimal } | { ok: false; reason: string } {
  if (categoryId === null) return { ok: true, rate: null, tax: NIL };
  if (!tables.inputTaxAllowed) return { ok: false, reason: `${at}: sales tax can be entered only when your company is registered for sales tax and the supplier is registered with an STRN. Choose "No sales tax".` };
  const category = tables.categories.get(categoryId);
  if (!category) return { ok: false, reason: `${at}: choose the tax category from the list.` };
  if (category.kind === "third_schedule") return { ok: false, reason: `${at}: goods taxed on their printed retail price cannot carry input tax on a bill yet.` };
  const rate = taxRateOn(tables.rates, categoryId, date);
  if (!rate) return { ok: false, reason: `${at}: no sales tax rate is in force for that category on the bill's date.` };
  return { ok: true, rate: rate.rate, tax: paisa(amount.times(rate.rate).div(100)) };
}

/**
 * The lines of a bill worked out: each line of goods against what is left to bill of what
 * arrived, each amount to the paisa, and the input tax on each.
 */
export function figureLines(draft: BillDraft, toBill: readonly ReceiptLineToBill[], tables: BillTaxTables): { ok: true; lines: FiguredLine[] } | { ok: false; reason: string } {
  const lines: FiguredLine[] = [];
  for (const [index, wanted] of draft.goods.entries()) {
    const at = `Goods, line ${index + 1}`;
    const from = toBill.find((line) => line.receiptLineId === wanted.receiptLineId);
    if (!from) return { ok: false, reason: `${at}: these goods were not received from this supplier into this branch, or have been billed since. Reload the page.` };
    const left = stillToBill(from);
    if (wanted.quantity.gt(left)) {
      const taken = from.billed.plus(from.returned ?? 0);
      const how = from.returned?.gt(0) ? (from.billed.isZero() ? `${taken.toFixed()} has been sent back` : `${taken.toFixed()} has been billed or sent back`) : `${from.billed.toFixed()} has been billed`;
      return { ok: false, reason: taken.isZero() ? `${from.itemCode}: ${from.received.toFixed()} arrived on ${from.receiptNumber}, so ${wanted.quantity.toFixed()} cannot be billed.` : `${from.itemCode}: ${from.received.toFixed()} arrived on ${from.receiptNumber} and ${how}, so only ${left.toFixed()} more can be billed.` };
    }
    const amount = paisa(wanted.quantity.times(wanted.unitPrice));
    const tax = lineTax(amount, wanted.taxCategoryId, draft.date, tables, at);
    if (!tax.ok) return tax;
    lines.push({ kind: "goods", receiptLineId: from.receiptLineId, itemId: from.itemId, accountId: null, description: from.description, quantity: wanted.quantity, unitPrice: wanted.unitPrice, amount, taxCategoryId: wanted.taxCategoryId, taxRate: tax.rate, salesTax: tax.tax });
  }
  for (const [index, wanted] of draft.expenses.entries()) {
    const tax = lineTax(wanted.amount, wanted.taxCategoryId, draft.date, tables, `Expenses, line ${index + 1}`);
    if (!tax.ok) return tax;
    lines.push({ kind: "expense", receiptLineId: null, itemId: null, accountId: wanted.accountId, description: wanted.description, quantity: null, unitPrice: null, amount: wanted.amount, taxCategoryId: wanted.taxCategoryId, taxRate: tax.rate, salesTax: tax.tax });
  }
  return { ok: true, lines };
}

/** A dated row of the withholding tables, as the bill needs it. */
export type WithholdingRule = { id: string; kind: WithholdingKind; code: string; label: string; effectiveFrom: string; base: WithholdingBase; rate: Decimal; rateNonAtl: Decimal | null; legalReference: string };

export type Withheld = { kind: WithholdingKind; code: string; label: string; legalReference: string; base: Decimal; rate: Decimal; amount: Decimal };

export type BillFigures = {
  /** The lines before tax. */
  amount: Decimal;
  /** Input tax on the lines. */
  salesTax: Decimal;
  /** The province's tax on the services billed: charged by the supplier, and withheld whole. */
  provincialTax: Decimal;
  total: Decimal;
  withheld: Withheld[];
  withheldTotal: Decimal;
  /** What is left owed to the supplier. */
  payable: Decimal;
};

const baseOf = (base: WithholdingBase, figures: { amount: Decimal; salesTax: Decimal; total: Decimal }) => (base === "gross_amount" ? figures.total : base === "taxable_value" ? figures.amount : figures.salesTax);

/**
 * What a bill comes to and what is withheld from it: the province's tax on its services at the
 * province's rate, income tax and sales tax withheld at the rate of the line chosen, for a
 * supplier who is or is not on the Active Taxpayers List. Every rate is the one in force on the
 * bill's date. A company that does not withhold chooses no line.
 */
export function figureBill(
  lines: readonly Pick<FiguredLine, "kind" | "amount" | "salesTax">[],
  chosen: { date: string; incomeTaxCode: string | null; salesTaxCode: string | null; provincialTaxCode: string | null },
  rules: readonly WithholdingRule[],
  company: { withholds: boolean; salesTaxRegistered: boolean },
  supplierOnActiveList: boolean,
): { ok: true; figures: BillFigures } | { ok: false; reason: string } {
  if (lines.length === 0) return { ok: false, reason: "Add at least one line to the bill." };
  const amount = lines.reduce((sum, line) => sum.plus(line.amount), NIL);
  const salesTax = lines.reduce((sum, line) => sum.plus(line.salesTax), NIL);
  const services = lines.filter((line) => line.kind === "expense").reduce((sum, line) => sum.plus(line.amount), NIL);
  if (!company.withholds && (chosen.incomeTaxCode || chosen.salesTaxCode || chosen.provincialTaxCode)) {
    return { ok: false, reason: "Your company does not withhold tax from suppliers. An owner or an accountant switches it on under Purchases, Withholding tax." };
  }
  const find = (code: string, kind: WithholdingKind) => {
    const rule = withholdingRuleOn(rules, code, chosen.date);
    return rule && rule.kind === kind ? rule : null;
  };

  let provincialTax = NIL;
  let provincialRule: WithholdingRule | null = null;
  if (chosen.provincialTaxCode) {
    provincialRule = find(chosen.provincialTaxCode, "provincial_sales_tax");
    if (!provincialRule) return { ok: false, reason: "The province's tax line chosen is not in force on the bill's date." };
    if (services.lte(0)) return { ok: false, reason: "The province's tax is on services. Add the service as an expense line, or choose no provincial tax." };
    provincialTax = paisa(services.times(provincialRule.rate).div(100));
  }
  const total = amount.plus(salesTax).plus(provincialTax);
  if (total.lte(0)) return { ok: false, reason: "The bill comes to nothing." };

  const withheld: Withheld[] = [];
  for (const [code, kind, word] of [
    [chosen.incomeTaxCode, "income_tax", "income tax"],
    [chosen.salesTaxCode, "sales_tax", "sales tax"],
  ] as const) {
    if (!code) continue;
    const rule = find(code, kind);
    if (!rule) return { ok: false, reason: `The ${word} withholding line chosen is not in force on the bill's date.` };
    const base = baseOf(rule.base, { amount, salesTax, total });
    const rate = withholdingRateFor(rule, supplierOnActiveList);
    if (base.lte(0) || rate.lte(0) || (kind === "sales_tax" && !company.salesTaxRegistered)) {
      return { ok: false, reason: `There is nothing on the bill for the ${word} line to be withheld from. Choose another line, or none.` };
    }
    withheld.push({ kind, code: rule.code, label: rule.label, legalReference: rule.legalReference, base, rate, amount: paisa(base.times(rate).div(100)) });
  }
  if (provincialRule) withheld.push({ kind: "provincial_sales_tax", code: provincialRule.code, label: provincialRule.label, legalReference: provincialRule.legalReference, base: services, rate: provincialRule.rate, amount: provincialTax });
  const withheldTotal = withheld.reduce((sum, entry) => sum.plus(entry.amount), NIL);
  if (withheld.some((entry) => entry.amount.lte(0)) || withheldTotal.gt(total)) return { ok: false, reason: "What would be withheld is not an amount between nothing and the bill. Check the withholding lines." };
  return { ok: true, figures: { amount, salesTax, provincialTax, total, withheld, withheldTotal, payable: total.minus(withheldTotal) } };
}

/**
 * The income tax line a supplier's bill usually falls under, by what the supplier is and what
 * is billed: only a suggestion, shown chosen on a new bill of a company that withholds.
 */
export function suggestedIncomeTaxCode(supplierType: "company" | "individual" | "aop", goods: boolean): string {
  if (goods) return supplierType === "company" ? "income_tax.goods.company" : "income_tax.goods.non_company";
  return "income_tax.services.other";
}
