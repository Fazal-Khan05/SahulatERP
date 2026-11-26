import Decimal from "decimal.js";
import { formatAmount } from "@/lib/money";
import { addCurrency, setRate } from "@/modules/currencies/commands";
import { createParty } from "@/modules/parties/commands";
import { cancelOrder, postReceipt as postGoodsReceipt, saveOrderDraft, saveReceiptDraft as saveGoodsReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getOrder, getReceipt } from "@/modules/purchasing/queries";
import { addShipmentCharge, addShipmentReceipt, allocateShipment, openShipment, updateShipment } from "@/modules/shipments/commands";
import { getShipment } from "@/modules/shipments/queries";
import { postBill, saveBillDraft, setWithholding } from "@/modules/supplier-bills/commands";
import { getBill } from "@/modules/supplier-bills/queries";
import type { RawBill } from "@/modules/supplier-bills/rules";
import { applyAdvance, postPayment, recordChallan, savePaymentDraft } from "@/modules/supplier-payments/commands";
import { getWithholdingPosition } from "@/modules/supplier-payments/queries";
import { postReturn, saveReturnDraft } from "@/modules/supplier-returns/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { accountId, type Demo } from "../world";

// Buying: suppliers, purchase orders, goods received (one in part), bills (one overdue, one paid
// in part), payments, an advance, a return to a supplier, tax withheld and paid over, and one
// import shipment with its charges spread over the goods. All through the app's own commands.

type Line = [code: string, quantity: number, unitCost: number];

async function order(d: Demo, who: TenantContext, head: { date: string; supplier: string; warehouseId: string; expectedOn?: string; reference?: string; note?: string }, lines: Line[]) {
  const { id } = await saveOrderDraft(who, null, {
    date: head.date,
    supplierId: d.suppliers[head.supplier],
    warehouseId: head.warehouseId,
    expectedOn: head.expectedOn ?? "",
    supplierReference: head.reference ?? "",
    note: head.note ?? "",
    lines: lines.map(([code, quantity, unitCost]) => ({ itemId: d.items[code], unitId: "", quantity: String(quantity), unitCost: String(unitCost) })),
  });
  const { number } = await submitOrder(who, id);
  return { id, number };
}

/** Receives goods on an order: everything still to come, or the quantities named by item code. */
async function receive(d: Demo, orderId: string, date: string, deliveryNote: string, only?: Record<string, number>) {
  const placed = (await getOrder(d.owner, orderId))!;
  const lines = placed.toReceive
    .map((line) => ({ orderLineId: line.lineId, quantity: only ? String(only[line.itemCode] ?? 0) : line.ordered.minus(line.received).toFixed() }))
    .filter((line) => line.quantity !== "0");
  const { id } = await saveGoodsReceiptDraft(d.warehouse, null, orderId, { date, supplierDeliveryNote: deliveryNote, lines });
  const { number } = await postGoodsReceipt(d.warehouse, id);
  const note = (await getReceipt(d.owner, id))!;
  return { id, number, lines: note.lines };
}

async function bill(d: Demo, raw: RawBill) {
  const draft = await saveBillDraft(d.accountant, null, raw);
  const { number } = await postBill(d.accountant, draft.id, draft.updatedAt);
  const posted = (await getBill(d.accountant, draft.id))!;
  return { id: draft.id, number, total: posted.total, payable: posted.payable, withheld: posted.withheld, lines: posted.lines };
}

async function pay(d: Demo, raw: { date: string; supplier: string; branchId: string; accountId: string; amount: Decimal; reference?: string; note?: string; allocations?: { billId: string; amount: Decimal }[]; foreignCurrency?: string; foreignAmount?: string }) {
  const draft = await savePaymentDraft(d.accountant, null, {
    date: raw.date,
    supplierId: d.suppliers[raw.supplier],
    branchId: raw.branchId,
    accountId: raw.accountId,
    amount: raw.amount.toFixed(2),
    reference: raw.reference ?? "",
    note: raw.note ?? "",
    foreignCurrency: raw.foreignCurrency ?? "",
    foreignAmount: raw.foreignAmount ?? "",
    allocations: (raw.allocations ?? []).map((a) => ({ billId: a.billId, amount: a.amount.toFixed(2) })),
  });
  const { number } = await postPayment(d.accountant, draft.id, draft.updatedAt);
  return { id: draft.id, number };
}

export async function seedBuying(d: Demo): Promise<void> {
  const { owner, accountant, day, shift } = d;

  // ── Suppliers: every name invented ──────────────────────────────────────────────────────────
  // code, name, type, city, province, credit days, NTN (made up), on the Active Taxpayers List
  const SUPPLIERS: [string, string, string, string, string, number, string, string][] = [
    ["S-001", "Indus Auto Parts (Pvt) Ltd", "company", "Karachi", "sindh", 30, "4410227", "active"],
    ["S-002", "Ravi Tyre Traders", "aop", "Lahore", "punjab", 15, "5120384", "active"],
    ["S-003", "Guangzhou Hengli Motor Parts Co", "company", "Guangzhou", "", 0, "", "unknown"],
    ["S-004", "Keamari Clearing Agency", "aop", "Karachi", "sindh", 7, "3307715", "active"],
    ["S-005", "Clifton Guard Services", "aop", "Karachi", "sindh", 15, "6021943", "inactive"],
  ];
  for (const [code, name, supplierType, city, province, creditDays, ntn, atlStatus] of SUPPLIERS) {
    d.suppliers[code] = (
      await createParty(accountant, "supplier", { name, code, supplierType, city, province, creditDays: String(creditDays), ntn, atlStatus, address: `Office ${code.slice(2)}, Main Road`, contactName: "Accounts", email: `accounts-${code.toLowerCase()}@${d.people.OWNER.email.split("@")[1]}` })
    ).id;
  }
  // The company withholds income tax from what it pays its suppliers (section 153), and the
  // province's tax on services; its sales are not registered for sales tax.
  await setWithholding(owner, true);
  // Foreign currencies are kept for the record: the books are in rupees.
  const usd = (await addCurrency(accountant, { code: "USD", name: "US Dollar" })).id;
  const cny = (await addCurrency(accountant, { code: "CNY", name: "Chinese Yuan" })).id;
  await setRate(accountant, { currencyId: usd, date: d.lastMonth, rate: "278.40", source: "Bank counter" });
  await setRate(accountant, { currencyId: usd, date: d.thisMonth > d.yesterday ? d.yesterday : d.thisMonth, rate: "279.10", source: "Bank counter" });
  await setRate(accountant, { currencyId: cny, date: d.lastMonth, rate: "38.20", source: "Bank counter" });

  // ── 1. A local order, received in full, billed with tax withheld, paid in full ──────────────
  const first = await order(d, accountant, { date: day(0, 4), supplier: "S-001", warehouseId: d.karachi, expectedOn: day(0, 8), reference: "IAP/Q-311" }, [["BR-101", 300, 295], ["EN-301", 400, 212], ["LT-201", 500, 124]]);
  const firstGoods = await receive(d, first.id, day(0, 6), "DC-7781");
  const firstBill = await bill(d, {
    date: day(0, 7), supplierId: d.suppliers["S-001"], branchId: d.karachiBranch, supplierInvoiceNo: "IAP/1182", dueDate: shift(day(0, 7), 30), incomeTaxCode: "income_tax.goods.company",
    goods: firstGoods.lines.map((line) => ({ receiptLineId: line.id, quantity: line.quantity.toFixed(), unitPrice: String(line.itemCode === "BR-101" ? 295 : line.itemCode === "EN-301" ? 212 : 124) })),
  });
  const firstPayment = await pay(d, { date: day(0, 26), supplier: "S-001", branchId: d.karachiBranch, accountId: d.bank, amount: firstBill.payable, reference: "CHQ 100231", allocations: [{ billId: firstBill.id, amount: firstBill.payable }] });

  // ── 2. An order received in part and billed for what came: unpaid, and overdue by now ───────
  const tyres = await order(d, accountant, { date: day(0, 10), supplier: "S-002", warehouseId: d.lahore, expectedOn: day(0, 14), reference: "RTT-0921" }, [["TY-401", 60, 3250], ["TY-410", 200, 440]]);
  const tyreGoods = await receive(d, tyres.id, day(0, 13), "RTT/DN/455", { "TY-401": 40, "TY-410": 200 });
  const tyreBill = await bill(d, {
    date: day(0, 14), supplierId: d.suppliers["S-002"], branchId: d.lahoreBranch, supplierInvoiceNo: "RTT-INV-2207", dueDate: shift(day(0, 14), 15), incomeTaxCode: "income_tax.goods.non_company",
    goods: tyreGoods.lines.map((line) => ({ receiptLineId: line.id, quantity: line.quantity.toFixed(), unitPrice: String(line.itemCode === "TY-401" ? 3250 : 440) })),
  });

  // ── 3. This month's order: received, four helmets sent back, billed, half paid ──────────────
  const second = await order(d, accountant, { date: day(1, 3), supplier: "S-001", warehouseId: d.karachi, expectedOn: day(1, 6), reference: "IAP/Q-340" }, [["AC-501", 80, 1480], ["EN-310", 60, 1270], ["BR-110", 50, 910]]);
  const secondGoods = await receive(d, second.id, day(1, 5), "DC-7902");
  const cost = (code: string) => (code === "AC-501" ? 1480 : code === "EN-310" ? 1270 : 910);
  const secondBill = await bill(d, {
    date: day(1, 6), supplierId: d.suppliers["S-001"], branchId: d.karachiBranch, supplierInvoiceNo: "IAP/1240", dueDate: shift(day(1, 6), 30), incomeTaxCode: "income_tax.goods.company",
    goods: secondGoods.lines.map((line) => ({ receiptLineId: line.id, quantity: line.quantity.toFixed(), unitPrice: String(cost(line.itemCode)) })),
  });
  // Four helmets with cracked shells go back; the supplier's credit note brings down what is owed.
  const helmets = secondGoods.lines.find((line) => line.itemCode === "AC-501")!;
  const helmetsBilled = secondBill.lines.find((line) => line.receiptLineId === helmets.id)!;
  const sentBack = await saveReturnDraft(accountant, null, { date: day(1, 8), receiptId: secondGoods.id, reason: "Four helmets arrived with cracked shells", supplierReference: "IAP/CN-58", lines: [{ receiptLineId: helmets.id, billLineId: helmetsBilled.id, quantity: "4" }] });
  const debitNote = await postReturn(accountant, sentBack.id, sentBack.updatedAt);
  const half = secondBill.payable.div(2).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  const partPayment = await pay(d, { date: day(1, 12), supplier: "S-001", branchId: d.karachiBranch, accountId: d.bank, amount: half, reference: "CHQ 100264", allocations: [{ billId: secondBill.id, amount: half }] });

  // ── 4. Goods that have arrived and are not billed yet ───────────────────────────────────────
  const unbilled = await order(d, accountant, { date: day(1, 10), supplier: "S-002", warehouseId: d.lahore, expectedOn: day(1, 14), reference: "RTT-0968" }, [["TY-402", 40, 2850], ["TY-411", 150, 410]]);
  const unbilledGoods = await receive(d, unbilled.id, day(1, 12), "RTT/DN/489", { "TY-402": 25 });

  // ── 5. A service, with the province's tax and income tax withheld: unpaid ───────────────────
  const guards = await bill(d, {
    date: day(1, 2), supplierId: d.suppliers["S-005"], branchId: d.karachiBranch, supplierInvoiceNo: "CGS/2611", dueDate: shift(day(1, 2), 15), incomeTaxCode: "income_tax.services.other", provincialTaxCode: "provincial_sales_tax.sindh",
    expenses: [{ accountId: await accountId(d, "5330"), description: "Guards for the Karachi warehouse, last month", amount: "42000" }],
  });

  // ── 6. The tax withheld last month, paid over to the government with its challan ────────────
  const position = await getWithholdingPosition(owner);
  const lastMonths = position.unpaid.filter((entry) => entry.kind === "income_tax" && entry.date < d.thisMonth);
  let challan = "";
  if (lastMonths.length > 0) {
    challan = (await recordChallan(owner, { kind: "income_tax", paidOn: day(1, 7), accountId: d.bank, challanNo: "IT-20261107-004418", note: "Tax withheld from suppliers last month", entryIds: lastMonths.map((entry) => entry.entryId) })).number;
  }

  // ── 7. An order written and not yet sent, and one cancelled ─────────────────────────────────
  await saveOrderDraft(accountant, null, { date: day(1, 14), supplierId: d.suppliers["S-001"], warehouseId: d.karachi, expectedOn: "", supplierReference: "", note: "Waiting for their new price list", lines: [{ itemId: d.items["LT-210"], unitId: "", quantity: "60", unitCost: "2550" }, { itemId: d.items["EN-340"], unitId: "", quantity: "40", unitCost: "3950" }] });
  const dropped = await order(d, accountant, { date: day(1, 9), supplier: "S-002", warehouseId: d.lahore, reference: "RTT-0960" }, [["TY-420", 300, 44]]);
  await cancelOrder(accountant, dropped.id, "They could not supply rim tape this month");

  // ── 8. An import: paid in advance, received, and its charges spread over the goods ──────────
  const advance = await pay(d, { date: day(0, 3), supplier: "S-003", branchId: d.karachiBranch, accountId: d.bank, amount: new Decimal(250000), reference: "TT 44810", note: "Advance against proforma GZ-2291", foreignCurrency: "USD", foreignAmount: "897.99" });
  const imported = await order(d, accountant, { date: day(0, 3), supplier: "S-003", warehouseId: d.karachi, expectedOn: day(0, 24), reference: "GZ-2291", note: "By sea, one 20 ft container shared" }, [["LT-240", 60, 1850], ["EN-302", 80, 2800], ["EN-320", 60, 2020]]);
  const importedGoods = await receive(d, imported.id, day(0, 22), "GZ/PL-2291");
  const importCost = (code: string) => (code === "LT-240" ? 1850 : code === "EN-302" ? 2800 : 2020);
  const importBill = await bill(d, {
    date: day(0, 22), supplierId: d.suppliers["S-003"], branchId: d.karachiBranch, supplierInvoiceNo: "GZ-CI-2291", dueDate: "",
    goods: importedGoods.lines.map((line) => ({ receiptLineId: line.id, quantity: line.quantity.toFixed(), unitPrice: String(importCost(line.itemCode)) })),
  });
  await applyAdvance(accountant, advance.id, { date: day(0, 22), allocations: [{ billId: importBill.id, amount: "250000" }] });
  const shipment = await openShipment(accountant, { openedOn: day(0, 5), supplierId: d.suppliers["S-003"], branchId: d.karachiBranch, stage: "shipped", origin: "Guangzhou", port: "Karachi (KICT)", containerNo: "TGHU4418207", blNumber: "COSU6291884", expectedOn: day(0, 20), note: "Wiring harnesses, piston kits and sprocket kits" });
  await addShipmentReceipt(accountant, shipment.id, importedGoods.id);
  await updateShipment(accountant, shipment.id, { stage: "cleared", origin: "Guangzhou", port: "Karachi (KICT)", containerNo: "TGHU4418207", blNumber: "COSU6291884", gdNumber: "KAPW-HC-44817-2026", gdDate: day(0, 20), customsValue: "455200", expectedOn: day(0, 20), note: "Wiring harnesses, piston kits and sprocket kits" });
  // The clearing agent's bill: each charge on a line of its own, charged to Goods in transit.
  const transit = await accountId(d, "1310");
  const CHARGES: [string, string, "inventory" | "advance_income_tax" | "deposit" | "expense", "value" | "quantity" | null, string | null][] = [
    ["Sea freight, Guangzhou to Karachi", "86000", "inventory", "value", null],
    ["Customs duty", "91040", "inventory", "value", null],
    ["Terminal handling and wharfage", "18500", "inventory", "quantity", null],
    ["Income tax paid at import (section 148)", "27300", "advance_income_tax", null, null],
    ["Container deposit", "30000", "deposit", null, "1220"],
    ["Clearing agent's fee", "12000", "expense", null, "5310"],
  ];
  const agentBill = await bill(d, {
    date: day(0, 23), supplierId: d.suppliers["S-004"], branchId: d.karachiBranch, supplierInvoiceNo: "KCA/1107", dueDate: shift(day(0, 23), 7),
    expenses: CHARGES.map(([description, amount]) => ({ accountId: transit, description, amount })),
  });
  const waiting = (await getShipment(accountant, shipment.id))!.billLinesToAdd;
  for (const [description, , kind, basis, account] of CHARGES) {
    const line = waiting.find((choice) => choice.label.includes(description));
    if (!line) throw new Error(`The shipment does not offer the charge "${description}".`);
    await addShipmentCharge(accountant, shipment.id, { billLineId: line.billLineId, class: kind, basis: basis ?? undefined, accountId: account ? await accountId(d, account) : undefined });
  }
  await allocateShipment(accountant, shipment.id, { date: day(0, 23) });
  const agentPayment = await pay(d, { date: day(0, 27), supplier: "S-004", branchId: d.karachiBranch, accountId: d.bank, amount: agentBill.payable, reference: "CHQ 100233", allocations: [{ billId: agentBill.id, amount: agentBill.payable }] });

  Object.assign(d.facts, {
    purchaseOrder: first.number, goodsReceived: firstGoods.number, bill: firstBill.number, billWithheld: formatAmount(firstBill.withheld), payment: firstPayment.number,
    overdueBill: tyreBill.number, overdueBillOwed: formatAmount(tyreBill.payable), partReceivedOrder: tyres.number,
    partPaidBill: secondBill.number, partPayment: partPayment.number, debitNote: debitNote.number,
    unbilledOrder: unbilled.number, unbilledGoods: unbilledGoods.number, serviceBill: guards.number, challan,
    cancelledOrder: dropped.number, shipment: shipment.number, importOrder: imported.number, importGoods: importedGoods.number, importBill: importBill.number, agentBill: agentBill.number, agentPayment: agentPayment.number, advance: advance.number,
  });
  d.said.push(`Buying: ${SUPPLIERS.length} suppliers; orders ${first.number} to ${imported.number}, one received in part, one cancelled, one still a draft; bills with tax withheld, ${tyreBill.number} overdue and ${secondBill.number} half paid; ${debitNote.number} for four helmets sent back; challan ${challan || "none"}.`);
  d.said.push(`Imports: shipment ${shipment.number} from Guangzhou, cleared, its freight, duty and handling spread over the goods.`);
}
