import Decimal from "decimal.js";
import { formatAmount } from "@/lib/money";
import { postCounterSale } from "@/modules/counter-sales/commands";
import { postMarketPurchase } from "@/modules/market-purchases/commands";
import { shortages } from "@/modules/market-purchases/rules";
import { createParty } from "@/modules/parties/commands";
import { createPriceList, setClassPrice, setCustomerPrice, setListPrice } from "@/modules/prices/commands";
import { postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { cancelSalesDocument, postDelivery, postInvoice, saveDeliveryDraft, saveInvoiceDraft, saveSalesDraft, startDelivery, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getDeliveryRows, getSalesDocument } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import type { Demo } from "../world";

// More selling, none of it with a share of commission, so the commission story of the first
// two months is left exactly as it was: price lists, an order held for the owner's approval, a
// quotation cancelled, an order delivered in part, a delivery short of stock finished with a
// quick market purchase, another left short, counter sales, and money received in other ways.

type Line = [code: string, quantity: number];

async function orderFor(d: Demo, who: TenantContext, kind: "quotation" | "order", date: string, customer: string, warehouseId: string, lines: Line[], shares: { userId: string; percent: string }[] = []) {
  const { id } = await saveSalesDraft(who, null, {
    kind, date, validUntil: kind === "quotation" ? d.shift(date, 15) : "", customerId: d.customers[customer], warehouseId, customerReference: "", notes: "",
    lines: lines.map(([code, quantity]) => ({ itemId: d.items[code], quantity: String(quantity), unitId: "", unitPrice: "", discountPercent: "", description: "" })),
    shares,
  });
  return { id, result: await submitSalesDocument(who, id) };
}

export async function seedSellingMore(d: Demo): Promise<void> {
  const { owner, accountant, manager, ali, sana, day, yesterday } = d;

  // ── Price lists, from yesterday, on items no open order holds ───────────────────────────────
  const dealers = (await createPriceList(manager, "Dealer price list")).id;
  for (const [item, price] of [["BR-130", "365"], ["AC-510", "820"], ["TY-420", "85"]]) await setListPrice(manager, dealers, { item, price, validFrom: yesterday, validTo: "" });
  const festival = (await createPriceList(manager, "Eid offer")).id;
  await setListPrice(manager, festival, { item: "AC-501", price: "2050", validFrom: yesterday, validTo: d.shift(yesterday, 30) });
  await setClassPrice(manager, { item: "EN-350", customerClass: "Workshop", price: "745", validFrom: yesterday });
  await setCustomerPrice(owner, { item: "BR-130", customer: "C-001", price: "350", validFrom: yesterday, validTo: d.shift(yesterday, 60) });

  // ── An order over the customer's credit limit: it waits for the owner ───────────────────────
  d.customers["C-011"] = (await createParty(owner, "customer", { name: "Orangi Auto Corner", code: "C-011", customerClass: "Retailer", creditDays: "15", creditLimit: "100000", city: "Karachi", province: "sindh", address: "Shop 11, Main Bazaar", contactName: "Accounts" })).id;
  const held = await orderFor(d, ali, "order", yesterday, "C-011", d.karachi, [["TY-401", 20], ["TY-402", 15]], [{ userId: d.people.ALI.id, percent: "100" }]);
  if (held.result.status !== "on_hold") throw new Error("The order over the credit limit was expected to wait for approval.");

  // ── A quotation the customer turned down ────────────────────────────────────────────────────
  const turnedDown = await orderFor(d, sana, "quotation", day(1, 11), "C-009", d.lahore, [["EN-350", 20], ["BR-102", 15]], [{ userId: d.people.SANA.id, percent: "100" }]);
  await cancelSalesDocument(sana, turnedDown.id, { reason: "They chose another supplier this time" });

  // ── An order delivered in part: the rest is still to go ─────────────────────────────────────
  const partly = await orderFor(d, owner, "order", day(1, 12), "C-007", d.lahore, [["BR-120", 60], ["AC-510", 20]]);
  const firstLoad = (await startDelivery(owner, partly.id)).id;
  const firstRows = (await getSalesDocument(owner, firstLoad))!;
  await saveDeliveryDraft(owner, firstLoad, { date: day(1, 13), lines: firstRows.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.itemCode === "BR-120" ? "40" : l.quantity.toFixed() })) });
  const partNote = await postDelivery(owner, firstLoad);

  // ── A delivery short of stock, finished with a quick market purchase ────────────────────────
  // Saddar Cycle House wants fifty LED headlights; Karachi holds fewer. The missing ones are
  // bought in the market for cash, and the delivery then goes through.
  const lights = await orderFor(d, owner, "order", day(1, 13), "C-005", d.karachi, [["LT-210", 50]]);
  const lightsNote = (await startDelivery(d.warehouse, lights.id)).id;
  const wanted = (await getSalesDocument(d.warehouse, lightsNote))!;
  const [missing] = shortages(await getDeliveryRows(d.warehouse, wanted));
  if (!missing) throw new Error("The delivery of LED headlights was expected to be short of stock.");
  const bought = await postMarketPurchase(owner, {
    date: day(1, 14), warehouseId: d.karachi, sellerKind: "market", sellerName: "Ejaz Lighting, Bolton Market", sellerPhone: "0333 5550173", memoNo: "CM-4471", note: `For ${lights.result.status === "submitted" ? lights.result.number : "the order"}`,
    lines: [{ itemId: d.items["LT-210"], unitId: "", quantity: missing.short.toFixed(), unitCost: "2750", description: "" }], method: "cash", accountId: d.cash,
  });
  await saveDeliveryDraft(d.warehouse, lightsNote, { date: day(1, 14), lines: wanted.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  const lightsDelivered = await postDelivery(d.warehouse, lightsNote);
  const lightsInvoice = (await startInvoice(owner, lightsNote)).id;
  const lightsDraft = (await getSalesDocument(owner, lightsInvoice))!;
  await saveInvoiceDraft(owner, lightsInvoice, { date: day(1, 14), lines: lightsDraft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  const lightsBilled = await postInvoice(owner, lightsInvoice);
  const lightsTotal = (await getSalesDocument(owner, lightsInvoice))!.totals.total;

  // ── A delivery left short, for the shortage card on its page ────────────────────────────────
  const carbs = await orderFor(d, owner, "order", yesterday, "C-002", d.karachi, [["EN-340", 30]]);
  const shortNote = (await startDelivery(d.warehouse, carbs.id)).id;

  // ── Counter sales at the shop: a walk-in buyer pays as he buys ──────────────────────────────
  const counterCash = await postCounterSale(owner, {
    date: day(1, 10), warehouseId: d.shop, buyerName: "Usman Tariq", buyerPhone: "0301 5550142", notes: "",
    lines: [{ itemId: d.items["AC-501"], quantity: "2", unitId: "", unitPrice: "", discountPercent: "", description: "" }, { itemId: d.items["LT-201"], quantity: "4", unitId: "", unitPrice: "", discountPercent: "", description: "" }],
    shares: [], method: "cash", accountId: d.cash,
  });
  const counterCard = await postCounterSale(accountant, {
    date: yesterday, warehouseId: d.shop, buyerName: "Hamza Sheikh", buyerPhone: "", notes: "",
    lines: [{ itemId: d.items["AC-530"], quantity: "3", unitId: "", unitPrice: "", discountPercent: "5", description: "" }, { itemId: d.items["EN-301"], quantity: "6", unitId: "", unitPrice: "", discountPercent: "", description: "" }],
    shares: [], method: "bank", accountId: d.bank, reference: "Card 7714",
  });

  // ── Money received in other ways ────────────────────────────────────────────────────────────
  // Part of the LED headlights invoice by bank transfer, the bank keeping its charges; taken by the recovery officer.
  const part = lightsTotal.div(2).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  const transfer = await saveReceiptDraft(d.recovery, null, { date: yesterday, customerId: d.customers["C-005"], method: "bank", accountId: d.bank, amount: part.toFixed(2), bankCharges: "150", reference: "IBFT 88213307", chequeNumber: "", chequeBank: "", chequeDate: "", allocations: [{ kind: "invoice", id: lightsInvoice, amount: part.toFixed(2) }] });
  const transferNumber = (await postReceipt(d.recovery, transfer.id)).number;
  // Money paid ahead by a customer who has no invoice yet: an advance.
  const ahead = await saveReceiptDraft(accountant, null, { date: yesterday, customerId: d.customers["C-011"], method: "cash", accountId: d.cash, amount: "30000.00", reference: "", note: "Paid ahead against their order", chequeNumber: "", chequeBank: "", chequeDate: "", allocations: [] });
  const aheadNumber = (await postReceipt(accountant, ahead.id)).number;

  Object.assign(d.facts, {
    heldOrderCustomer: "Orangi Auto Corner", partDelivery: partNote.number,
    shortOrder: lights.result.status === "submitted" ? lights.result.number : "", marketPurchaseOrder: bought.orderNumber, marketPurchaseBill: bought.billNumber, marketPurchasePayment: bought.paymentNumber, marketPurchaseTotal: formatAmount(new Decimal(bought.total)),
    shortDelivery: lightsDelivered.number, shortInvoice: lightsBilled.number, leftShortOrder: carbs.result.status === "submitted" ? carbs.result.number : "", leftShortNote: shortNote,
    counterSaleCash: counterCash.invoiceNumber, counterSaleCashTotal: formatAmount(new Decimal(counterCash.total)), counterSaleCard: counterCard.invoiceNumber,
    bankReceipt: transferNumber, advanceReceipt: aheadNumber,
  });
  d.said.push(`More selling: two price lists, class and customer prices; an order held for approval; a quotation cancelled; ${partNote.number} delivers an order in part.`);
  d.said.push(`A short delivery: ${missing.short.toFixed()} LED headlights bought in the market (${bought.orderNumber}, ${bought.billNumber}, ${bought.paymentNumber}) so ${lightsDelivered.number} could go; another delivery is left short of carburettors. Counter sales ${counterCash.invoiceNumber} and ${counterCard.invoiceNumber}.`);
}
