import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { postCreditNote, saveCreditNoteDraft, startCreditNote } from "@/modules/credit-notes/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postReceipt as postGoodsReceipt, saveOrderDraft, saveReceiptDraft as saveGoodsReceiptDraft, submitOrder } from "@/modules/purchasing/commands";
import { getOrder } from "@/modules/purchasing/queries";
import { postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { postInvoice, saveInvoiceDraft, saveSalesDraft, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import { addShipmentCharge, addShipmentReceipt, allocateShipment, openShipment } from "@/modules/shipments/commands";
import { postBill, saveBillDraft } from "@/modules/supplier-bills/commands";
import { postReturn, saveReturnDraft } from "@/modules/supplier-returns/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { seedStock } from "../../../tests/support/stock";
import { getReturnStanding, getTaxReturn, setReturnProvince, WHOLE_COMPANY_ONLY } from "./queries";
import { annexCsv, annexTable, groupH1, readReturnPeriod, reconcile, type TaxReturn } from "./rules";

// The sales tax return against a real database, through the app's own path (app_runtime,
// withTenant, row-level security). One November of an importer's trade is posted, each document
// by its own step's commands, and the annexes are then read and set beside the ledger. The
// plan's test is the first: "Annex-C total equals output tax in the ledger for the month".
// Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-tax-return-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const warehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@taxreturn.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northAccountant, tenantA, "accountant", [northBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const NOVEMBER = readReturnPeriod("2026-11", "2026-12-05");
const DECEMBER = readReturnPeriod("2026-12", "2026-12-05");

let admin: AdminSql;
let helmet = "";
let glove = "";
let chain = "";
let sialkot = "";
let ningbo = "";
let agent = "";
let dealer = "";
let rider = "";
let bank = "";
let transit = "";
let november: TaxReturn;

async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
/** What the month's journals did to a sales tax account: credits less debits. */
const ledgerCredit = async (control: string, from: string, to: string) =>
  (
    await admin<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l
      join public.journals j on j.id = l.journal_id join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type = ${control} and j.journal_date between ${from} and ${to}`
  )[0].v;
/** Goods ordered and received in full: the goods received note and its lines. */
async function received(supplierId: string, date: string, lines: { itemId: string; quantity: string; unitCost: string }[]): Promise<{ receiptId: string; lineIds: string[] }> {
  const order = await saveOrderDraft(as.owner, null, { date, supplierId, warehouseId: warehouse, lines });
  await submitOrder(as.owner, order.id);
  const placed = await getOrder(as.owner, order.id);
  const note = await saveGoodsReceiptDraft(as.warehouse_manager, null, order.id, { date, lines: placed!.lines.map((line) => ({ orderLineId: line.id, quantity: line.quantity.toFixed() })) });
  await postGoodsReceipt(as.warehouse_manager, note.id);
  const rows = await admin<{ id: string }[]>`select id from public.goods_receipt_lines where tenant_id = ${tenantA} and receipt_id = ${note.id} order by line_no`;
  return { receiptId: note.id, lineIds: rows.map((row) => row.id) };
}
/** An order invoiced in full straight away, which takes the goods out of stock. */
async function invoiced(customerId: string, date: string, itemId: string, quantity: string): Promise<string> {
  const order = await saveSalesDraft(as.salesperson, null, { kind: "order", date, customerId, warehouseId: warehouse, lines: [{ itemId, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" }], shares: [{ userId: userIds.salesperson, percent: "100" }] });
  await submitSalesDocument(as.salesperson, order.id);
  const { id } = await startInvoice(as.salesperson, order.id);
  const draft = (await getSalesDocument(as.salesperson, id))!;
  await saveInvoiceDraft(as.salesperson, id, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postInvoice(as.salesperson, id);
  return id;
}
const money = (rows: { cells: unknown[] }[], at: number) => String(rows.at(-1)!.cells[at]);

describe.skipIf(!hasDb)("the sales tax return", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${warehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: northAccountant, email: north.email, role: "accountant", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, strn, ntn, tax_rates_confirmed_at, accounts_template, completed_by) values (${tenantA}, true, '1234567890123', '7654321', now(), 'trading', ${userIds.owner})`;
    await admin`select app.seed_tax_defaults(${tenantA}, ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = ${code}`)[0].id;
    transit = await account("1310");
    bank = (await addAccount(as.owner, { parentId: await account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    glove = (await createItem(as.owner, { code: "GL-2", name: "Glove", unit: piece, defaultPrice: "2500" })).id;
    chain = (await createItem(as.owner, { code: "CH-3", name: "Chain", unit: piece, defaultPrice: "400" })).id;
    // What an item's card says of its goods, written as the item screens would (HS code, FBR's unit).
    await admin`update public.items set hs_code = '6506.1000', fbr_uom_code = 'Numbers, pieces, units' where tenant_id = ${tenantA} and id = ${helmet}`;
    await admin`update public.items set hs_code = '4203.2100' where tenant_id = ${tenantA} and id = ${glove}`;
    sialkot = (await createParty(as.owner, "supplier", { name: "Sialkot Sports Ltd", supplierType: "company", registrationType: "registered", ntn: "7654321", strn: "3277876123456", atlStatus: "active" })).id;
    ningbo = (await createParty(as.owner, "supplier", { name: "Ningbo Exports", supplierType: "company" })).id;
    agent = (await createParty(as.owner, "supplier", { name: "Karachi Clearing", supplierType: "aop" })).id;
    dealer = (await createParty(as.owner, "customer", { name: "Registered Dealer", code: "C-001", registrationType: "registered", ntn: "1234567", strn: "3277876123457", atlStatus: "active", creditDays: "30" })).id;
    rider = (await createParty(as.owner, "customer", { name: "Walk-in Rider", code: "C-002" })).id;
    const [{ id: standard }] = await admin<{ id: string }[]>`select id from public.tax_categories where tenant_id = ${tenantA} and kind = 'standard' order by created_at limit 1`;

    // October: twenty chains already on the shelf, worth 4,000.
    await seedStock(admin, { tenantId: tenantA, itemId: chain, warehouseId: warehouse, quantity: "20", value: "4000", userId: userIds.owner, date: "2026-10-15" });

    // 3 November: ten helmets at 600 from a registered supplier at home, billed on the 4th with 18% sales tax.
    const home = await received(sialkot, "2026-11-03", [{ itemId: helmet, quantity: "10", unitCost: "600" }]);
    const bill = await saveBillDraft(as.accountant, null, { date: "2026-11-04", supplierId: sialkot, branchId: mainBranch, supplierInvoiceNo: "SS/901", goods: [{ receiptLineId: home.lineIds[0], quantity: "10", unitPrice: "600", taxCategoryId: standard }] });
    await postBill(as.accountant, bill.id, bill.updatedAt);

    // 3 November: ten gloves at 1,000 from abroad, on a shipment; freight of 5,000 and sales tax of 3,000 paid at the port, spread on the 6th.
    const abroad = await received(ningbo, "2026-11-03", [{ itemId: glove, quantity: "10", unitCost: "1000" }]);
    const shipment = await openShipment(as.accountant, { openedOn: "2026-11-03", supplierId: ningbo, branchId: mainBranch, gdNumber: "KAPW-HC-12345", gdDate: "2026-11-02", customsValue: "10000", port: "Karachi" });
    await addShipmentReceipt(as.accountant, shipment.id, abroad.receiptId);
    const port = await saveBillDraft(as.accountant, null, { date: "2026-11-04", supplierId: agent, branchId: mainBranch, supplierInvoiceNo: "KC-1", expenses: [{ accountId: transit, description: "Freight", amount: "5000" }, { accountId: transit, description: "Sales tax at import", amount: "3000" }] });
    await postBill(as.accountant, port.id, port.updatedAt);
    const portLines = await admin<{ id: string }[]>`select id from public.supplier_bill_lines where tenant_id = ${tenantA} and bill_id = ${port.id} order by line_no`;
    await addShipmentCharge(as.accountant, shipment.id, { billLineId: portLines[0].id, class: "inventory", basis: "value" });
    await addShipmentCharge(as.accountant, shipment.id, { billLineId: portLines[1].id, class: "sales_tax" });
    await allocateShipment(as.accountant, shipment.id, { date: "2026-11-06" });

    // 5 November: four helmets to the registered dealer, two to an unregistered rider (who is charged further tax).
    const toDealer = await invoiced(dealer, "2026-11-05", helmet, "4");
    await invoiced(rider, "2026-11-05", helmet, "2");

    // 8 November: one helmet comes back from the dealer.
    const note = await startCreditNote(as.sales_manager, toDealer);
    const [{ id: dealerLine }] = await admin<{ id: string }[]>`select id from public.sales_lines where document_id = ${toDealer} and item_id = ${helmet}`;
    await saveCreditNoteDraft(as.sales_manager, note.id, { date: "2026-11-08", lines: [{ sourceLineId: dealerLine, quantity: "1", damaged: "0" }] });
    await postCreditNote(as.sales_manager, note.id);

    // 9 November: the dealer pays 3,000 into the bank against the invoice.
    const receipt = await saveReceiptDraft(as.accountant, null, { date: "2026-11-09", customerId: dealer, method: "bank", accountId: bank, amount: "3000", reference: "IBFT 5512", allocations: [{ kind: "invoice", id: toDealer, amount: "3000" }] });
    await postReceipt(as.accountant, receipt.id, receipt.updatedAt);

    // 10 November: two of the billed helmets go back to the supplier.
    const [{ id: billLine }] = await admin<{ id: string }[]>`select id from public.supplier_bill_lines where tenant_id = ${tenantA} and bill_id = ${bill.id}`;
    const back = await saveReturnDraft(as.accountant, null, { date: "2026-11-10", receiptId: home.receiptId, reason: "Cracked shells", supplierReference: "SS/CN/17", lines: [{ receiptLineId: home.lineIds[0], billLineId: billLine, quantity: "2" }] });
    await postReturn(as.accountant, back.id, back.updatedAt);

    // 1 December: one more helmet to the dealer, which is not November's.
    await invoiced(dealer, "2026-12-01", helmet, "1");

    await setReturnProvince(as.accountant, "sindh");
    november = await getTaxReturn(as.accountant, NOVEMBER);
  }, 480_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("Annex-C total equals output tax in the ledger for the month", async () => {
    const table = annexTable(november, "annex-c");
    const taxAt = table.columns.findIndex((column) => column.label === "Sales Tax / FED in ST Mode");
    // Four helmets at 1,000 and two more, at 18%, less the one that came back: 720 + 360 - 180.
    expect(money(table.rows, taxAt)).toBe("900");
    expect(await ledgerCredit("output_tax", NOVEMBER.from, NOVEMBER.to)).toBe("900.00");
    // Further tax of 4% on the unregistered rider's 2,000.
    const furtherAt = table.columns.findIndex((column) => column.label === "Further Tax");
    expect(money(table.rows, furtherAt)).toBe("80");
    expect(await ledgerCredit("further_tax", NOVEMBER.from, NOVEMBER.to)).toBe("80.00");
  });

  it("lists each line of the month's invoices and credit notes as posting stored it", () => {
    expect(november.c.map((r) => `${r.docKind} ${r.number} ${r.buyerName} ${r.quantity} ${r.value} ${r.salesTax} ${r.furtherTax}`)).toEqual([
      "invoice SI-2627-00001 Registered Dealer 4 4000 720 0",
      "invoice SI-2627-00002 Walk-in Rider 2 2000 360 80",
      "credit_note CN-2627-00001 Registered Dealer 1 1000 180 0",
    ]);
    const [first, second, credit] = november.c;
    expect([first.buyerRegistered, first.buyerStrn, first.buyerNtn, first.hsCode, first.uom, first.taxRate.toString()]).toEqual([true, "3277876123457", "1234567", "6506.1000", "Numbers, pieces, units", "18"]);
    expect([second.buyerRegistered, second.buyerCnic, second.buyerNtn]).toEqual([false, null, null]);
    expect([credit.originalNumber, credit.originalDate]).toEqual(["SI-2627-00001", "2026-11-05"]);

    const table = annexTable(november, "annex-c");
    const cell = (row: number, label: string) => table.rows[row].cells[table.columns.findIndex((column) => column.label === label)];
    expect([cell(0, "Sr."), cell(0, "Document Type"), cell(0, "Document Date"), cell(0, "Rate"), cell(0, "Sale Origination Province of Supplier")]).toEqual(["1", "Sale Invoice", "05-11-2026", "18%", "Sindh"]);
    expect([cell(2, "Document Type"), cell(2, "Original Invoice Number"), cell(2, "Original Invoice Date")]).toEqual(["Credit Note", "SI-2627-00001", "05-11-2026"]);
    // What stands in the way of a clean file is said under the table.
    expect(table.notes).toContain("1 document is to an unregistered buyer with no CNIC or NTN.");
    // The file for upload is the headings and the rows: no title, no total, no note.
    const csv = annexCsv(table);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0].startsWith("Sr.,Buyer NTN,Buyer CNIC")).toBe(true);
    expect(lines[3]).toContain("Credit Note,CN-2627-00001,08-11-2026");
  });

  it("sets every annex beside the ledger, and they agree", () => {
    expect(reconcile(november).map((line) => `${line.label}: ${line.annex} / ${line.ledger} / ${line.other} ${line.agrees ? "agrees" : "DIFFERS"}`)).toEqual([
      "Output tax (Annex-C: sales tax and extra tax): 900 / 900 / 0 agrees",
      "Further tax (Annex-C): 80 / 80 / 0 agrees",
      // 1,080 on the bill, less 216 on the two helmets sent back.
      "Input tax on purchases (Annex-A): 864 / 864 / 0 agrees",
      "Input tax paid at import (Annex-B): 3000 / 3000 / 0 agrees",
      "Sales tax withheld from suppliers (Annex-A): 0 / 0 / 0 agrees",
    ]);
  });

  it("Annex-A lists purchases at home and debit notes, and leaves what was paid at the port to Annex-B", () => {
    expect(november.a.map((r) => `${r.docKind} ${r.number} ${r.supplierInvoiceNo} ${r.supplierName} ${r.lineKind} ${r.quantity} ${r.value} ${r.salesTax}`)).toEqual([
      "bill PB-2627-00001 SS/901 Sialkot Sports Ltd goods 10 6000 1080",
      // The freight is a purchase of a service; the sales tax paid at import is not a purchase.
      "bill PB-2627-00002 KC-1 Karachi Clearing expense null 5000 0",
      "debit_note DB-2627-00001 SS/CN/17 Sialkot Sports Ltd goods 2 1200 216",
    ]);
    expect([november.a[0].supplierStrn, november.a[0].hsCode, november.a[2].originalNumber]).toEqual(["3277876123456", "6506.1000", "PB-2627-00001"]);
    expect(november.b.map((r) => `${r.shipmentNumber} ${r.gdNumber} ${r.gdDate} ${r.port} ${r.supplierName} ${r.hsCodes} ${r.customsValue} ${r.salesTax} ${r.allocatedOn} ${r.firstSpreading}`)).toEqual([
      "SH-2627-00001 KAPW-HC-12345 2026-11-02 Karachi Ningbo Exports 4203.2100 10000 3000 2026-11-06 true",
    ]);
  });

  it("Annex-C1 lists the money set against invoices in the month", () => {
    expect(november.c1.map((r) => `${r.receiptNumber} ${r.method} ${r.reference} ${r.buyerName} ${r.invoiceNumber} ${r.invoiceTotal} ${r.invoiceTax} ${r.amount} ${r.allocatedOn}`)).toEqual([
      "RC-2627-00001 bank IBFT 5512 Registered Dealer SI-2627-00001 4720 720 3000 2026-11-09",
    ]);
  });

  it("Annex-H1 states the stock at cost: opening, imported, purchased, supplied and closing", async () => {
    expect(november.h1.map((r) => `${r.itemCode} ${r.hsCode}: opened ${r.openingQuantity}/${r.openingValue}, imported ${r.importedQuantity}/${r.importedValue}, purchased ${r.purchasedQuantity}/${r.purchasedValue}, supplied ${r.suppliedQuantity}/${r.suppliedValue}, other ${r.otherQuantity}/${r.otherValue}, closed ${r.closingQuantity}/${r.closingValue}`)).toEqual([
      // Ten gloves at 1,000 and the 5,000 of freight spread onto them.
      "GL-2 4203.2100: opened 0/0, imported 10/15000, purchased 0/0, supplied 0/0, other 0/0, closed 10/15000",
      // Ten helmets at 600 less two sent back; six sold and one returned, at 600 each.
      "HL-1 6506.1000: opened 0/0, imported 0/0, purchased 8/4800, supplied 5/3000, other 0/0, closed 3/1800",
      "CH-3 null: opened 20/4000, imported 0/0, purchased 0/0, supplied 0/0, other 0/0, closed 20/4000",
    ]);
    // What the statement closes at is what the warehouse held on the last day of the month.
    const closing = november.h1.reduce((total, r) => total.plus(r.closingValue), november.h1[0].closingValue.minus(november.h1[0].closingValue));
    const [{ held }] = await admin<{ held: string }[]>`select sum(value)::numeric(20,2)::text as held from public.stock_moves where tenant_id = ${tenantA} and move_date <= ${NOVEMBER.to}`;
    expect(closing.toFixed(2)).toBe(held);
    expect(groupH1(november.h1).map((g) => `${g.hsCode} ${g.description} ${g.closingQuantity}`)).toEqual(["4203.2100 Glove 10", "6506.1000 Helmet 3", "null Chain 20"]);
    expect(annexTable(november, "annex-h1").notes).toContain("Items with no HS code (1) are listed together on a row without one.");
  });

  it("keeps each month to itself", async () => {
    const december = await getTaxReturn(as.auditor, DECEMBER);
    expect(december.c.map((r) => `${r.number} ${r.salesTax}`)).toEqual(["SI-2627-00003 180"]);
    expect([december.a.length, december.b.length, december.c1.length]).toEqual([0, 0, 0]);
    // December opens with what November closed at.
    expect(december.h1.map((r) => `${r.itemCode} ${r.openingQuantity} ${r.suppliedQuantity} ${r.closingQuantity}`)).toEqual(["GL-2 10 0 10", "HL-1 3 1 2", "CH-3 20 0 20"]);
    expect(reconcile(december)[0]).toMatchObject({ agrees: true });
  });

  it("is read by the owner, an accountant or an auditor of the whole company, and by nobody else", async () => {
    for (const role of ["sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const) {
      await expect(getTaxReturn(as[role], NOVEMBER), role).rejects.toThrow("Only an owner, an accountant or an auditor can see the sales tax return.");
      // And the database itself refuses, whatever the app is told.
      for (const fn of ["annex_c_rows", "annex_c1_rows", "annex_a_rows", "annex_b_rows", "annex_h1_rows", "tax_return_ledger"]) {
        expect(await codeOf(as[role], sql`select * from ${sql.raw(`app.${fn}`)}(${NOVEMBER.from}::date, ${NOVEMBER.to}::date)`), `${role} ${fn}`).toBe("42501");
      }
    }
    // An accountant limited to one branch would get half a return: none at all.
    await expect(getTaxReturn(north, NOVEMBER)).rejects.toThrow(WHOLE_COMPANY_ONLY);
    expect(await codeOf(north, sql`select * from app.annex_c_rows(${NOVEMBER.from}::date, ${NOVEMBER.to}::date)`)).toBe("42501");
    // The gate itself is not the app's to call.
    expect(await codeOf(as.owner, sql`select app.tax_return_tenant()`)).toBe("42501");
    // Another company's owner reads their own, which is empty.
    const theirs = await getTaxReturn(otherOwner, NOVEMBER);
    expect([theirs.c.length, theirs.c1.length, theirs.a.length, theirs.b.length, theirs.h1.length, theirs.ledger.length]).toEqual([0, 0, 0, 0, 0, 0]);
    expect((await getTaxReturn(as.owner, NOVEMBER)).c).toHaveLength(3);
  });

  it("keeps the province the company supplies from, set by the owner or an accountant", async () => {
    expect(await getReturnStanding(as.auditor)).toEqual({ registered: true, strn: "1234567890123", ntn: "7654321", province: "sindh" });
    await expect(setReturnProvince(as.auditor, "punjab")).rejects.toThrow("Only an owner or an accountant can set the province.");
    await expect(setReturnProvince(as.owner, "atlantis")).rejects.toThrow("Choose a province.");
    await setReturnProvince(as.owner, "punjab");
    expect((await getReturnStanding(as.owner)).province).toBe("punjab");
    const rows = await admin<{ after: { province: string } }[]>`select after from public.audit_log where tenant_id = ${tenantA} and action = 'tax_return.province' order by at`;
    expect(rows.map((row) => row.after.province)).toEqual(["sindh", "punjab"]);
    // Written straight to the table: an auditor cannot, and nobody writes another company's.
    expect(await codeOf(as.auditor, sql`update public.tax_return_settings set province = 'sindh', updated_by = ${userIds.auditor}`)).toBeUndefined();
    expect((await getReturnStanding(as.owner)).province).toBe("punjab");
    expect(await codeOf(otherOwner, sql`insert into public.tax_return_settings (tenant_id, province, created_by, updated_by) values (${tenantA}, 'sindh', ${ownerB}, ${ownerB})`)).toBe("42501");
    await setReturnProvince(as.owner, "sindh");
  });
});
