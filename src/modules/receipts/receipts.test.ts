import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { addOpenDocument, postOpening, reverseOpening, setAccountBalance, startOpening } from "@/modules/opening/commands";
import { createParty } from "@/modules/parties/commands";
import { postInvoice, saveInvoiceDraft, saveSalesDraft, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getCustomerCredit, getSalesDocument } from "@/modules/sales/queries";
import { todayIso } from "@/lib/format";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { applyAdvance, bounceCheque, cancelReceipt, clearCheque, depositCheque, discardReceipt, postReceipt, saveReceiptDraft } from "./commands";
import { findCustomers, getCustomerStanding, getReceipt, listCheques, listMoneyAccounts, listOpenItems, listReceipts } from "./queries";

// Receipts and cheques against a real database, through the app's own path (app_runtime,
// withTenant, row-level security): what each posts, what a bounce and a cancellation take
// back, what is refused, and that the books always agree with what the invoices show as
// unpaid. The figures are those of docs/examples/step-32.md. Skipped when the database URLs
// are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-receipt-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "recovery_officer", "sales_manager", "salesperson", "warehouse_manager"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const cityCollector = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const cityBranch = randomUUID();
const mainWarehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@receipt.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const collector = ctx(cityCollector, tenantA, "recovery_officer", [cityBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const OPENED = "2026-10-01";

let admin: AdminSql;
let helmet: string;
let dealer: string;
let rider: string;
let cash: string;
let bank: string;
let first: string; // SI-2627-00001, Dealer, 10 October, 5,000
let second: string; // SI-2627-00002, Dealer, 12 October, 3,000
let third: string; // SI-2627-00003, Rider, 12 October, 2,000

/** The database's code for what a statement run as this member was refused with, or undefined when it went through. */
async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
/** A posted invoice for so many helmets at 1,000 each, straight from an order. */
async function sell(customerId: string, date: string, quantity: string): Promise<string> {
  const line = { itemId: helmet, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" };
  const order = await saveSalesDraft(as.salesperson, null, { kind: "order", date, customerId, warehouseId: mainWarehouse, lines: [line], shares: [] });
  await submitSalesDocument(as.salesperson, order.id);
  const { id } = await startInvoice(as.salesperson, order.id);
  const draft = (await getSalesDocument(as.salesperson, id))!;
  await saveInvoiceDraft(as.salesperson, id, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postInvoice(as.salesperson, id);
  return id;
}
const journalLines = async (journalId: string | null) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text || coalesce(' (' || c.name || ')', '') as line
      from public.journal_lines l join public.accounts a on a.id = l.account_id left join public.customers c on c.id = l.customer_id
      where l.journal_id = ${journalId} order by l.line_no`
  ).map((row) => row.line);
const reversalOf = async (journalId: string | null) => (await admin<{ id: string; journal_date: string }[]>`select id, journal_date::text from public.journals where reverses_journal_id = ${journalId}`)[0];
/** What the books say an account stands at, debit less credit; for one customer when named. */
async function balance(control: string, customerId?: string): Promise<string> {
  const [row] = await admin`
    select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.tenant_id = ${tenantA} and a.control_type = ${control} and (${customerId ?? null}::uuid is null or l.customer_id = ${customerId ?? null})`;
  return row.v;
}
const open = async (customerId: string, who: TenantContext = as.recovery_officer) => (await listOpenItems(who, customerId)).map((item) => `${item.number} ${item.outstanding.toFixed(2)} of ${item.total.toFixed(2)}`);
const pay = (id: string, amount: string, kind: "invoice" | "opening" = "invoice") => ({ kind, id, amount });

describe.skipIf(!hasDb)("receipts and cheques", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenantA}, 'City', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: cityCollector, email: collector.email, role: "recovery_officer", branch_ids: [cityBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = ${code}`)[0].id;
    cash = await account("1111");
    bank = (await addAccount(as.owner, { parentId: await account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    dealer = (await createParty(as.owner, "customer", { name: "Karachi Dealer", code: "C-001", creditDays: "30" })).id;
    rider = (await createParty(as.owner, "customer", { name: "Walk-in Rider", code: "C-002" })).id;

    // The books open on 1 October: the dealer still owes 1,200 on an old invoice, and the store holds 100 helmets.
    await startOpening(as.owner, { date: OPENED });
    await setAccountBalance(as.owner, { accountId: cash, debit: "10000", credit: "" });
    await addOpenDocument(as.owner, "receivable", { party: "C-001", documentNumber: "OLD-77", documentDate: "2026-09-05", dueDate: "2026-09-20", amount: "1200" });
    await postOpening(as.owner);
    const stock = await saveAdjustmentDraft(as.owner, "opening", null, { date: OPENED, warehouseId: mainWarehouse, lines: [{ itemCode: "HL-1", direction: "in", quantity: "100", unitCost: "600" }] });
    await postAdjustment(as.owner, stock.id);

    first = await sell(dealer, "2026-10-10", "5");
    second = await sell(dealer, "2026-10-12", "3");
    third = await sell(rider, "2026-10-12", "2");
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("shows what each customer has to pay, to those who collect it", async () => {
    expect(await open(dealer)).toEqual(["OLD-77 1200.00 of 1200.00", "SI-2627-00001 5000.00 of 5000.00", "SI-2627-00002 3000.00 of 3000.00"]);
    expect(await open(rider)).toEqual(["SI-2627-00003 2000.00 of 2000.00"]);
    const standing = (await getCustomerStanding(as.recovery_officer, dealer))!;
    expect(`${standing.name} owes ${standing.owes.toFixed(2)} on ${standing.items.length} invoices`).toBe("Karachi Dealer owes 9200.00 on 3 invoices");
    expect((await findCustomers(as.recovery_officer, "c-00")).map((c) => c.name)).toEqual(["Karachi Dealer", "Walk-in Rider"]);
    // The recovery officer chooses a cash or bank account without reading the chart of accounts.
    expect((await listMoneyAccounts(as.recovery_officer)).map((a) => `${a.code} ${a.name} ${a.kind}`)).toEqual(["1111 Cash in hand cash", "1121 HBL current account bank"]);
    for (const role of ["salesperson", "warehouse_manager"] as const) {
      await expect(listOpenItems(as[role], dealer), role).rejects.toThrow("Your role does not include receipts.");
      expect(await codeOf(as[role], sql`select * from app.receivables_open(${dealer})`), role).toBe("42501");
      expect(await codeOf(as[role], sql`select * from app.receipt_accounts()`), role).toBe("42501");
    }
    expect(await codeOf(as.sales_manager, sql`select * from app.receivables_open(${dealer})`)).toBeUndefined();
  });

  it("posts cash received against invoices, and keeps what is over as the customer's advance", async () => {
    const head = { date: "2026-10-15", customerId: dealer, method: "cash", accountId: cash, amount: "6000" };
    // Only those who collect record a receipt.
    for (const role of ["salesperson", "sales_manager", "auditor", "warehouse_manager"] as const) {
      await expect(saveReceiptDraft(as[role], null, { ...head, allocations: [] }), role).rejects.toThrow("Only an owner, an accountant or the recovery officer can record receipts.");
    }
    // What a receipt may pay: this customer's invoices, no more than is left, dated on or before it, no more than it holds.
    await expect(saveReceiptDraft(as.recovery_officer, null, { ...head, allocations: [pay(first, "5000.01")] })).rejects.toThrow("SI-2627-00001 has 5000.00 left to pay, not 5000.01.");
    await expect(saveReceiptDraft(as.recovery_officer, null, { ...head, allocations: [pay(third, "100")] })).rejects.toThrow("not an unpaid invoice of this customer");
    await expect(saveReceiptDraft(as.recovery_officer, null, { ...head, date: "2026-10-11", allocations: [pay(second, "100")] })).rejects.toThrow("SI-2627-00002 is dated after this receipt.");
    await expect(saveReceiptDraft(as.recovery_officer, null, { ...head, allocations: [pay(first, "5000"), pay(second, "1500")] })).rejects.toThrow("The invoices come to more than the amount received.");
    // Cash goes into a cash account: a draft that says otherwise is not posted.
    const wrong = await saveReceiptDraft(as.recovery_officer, null, { ...head, accountId: bank, allocations: [] });
    await expect(postReceipt(as.recovery_officer, wrong.id)).rejects.toThrow("Choose a cash account for cash");
    await discardReceipt(as.recovery_officer, wrong.id);

    const { id, updatedAt } = await saveReceiptDraft(as.recovery_officer, null, { ...head, note: "Collected at the shop", allocations: [pay(first, "5000"), pay(second, "500")] });
    const draft = (await getReceipt(as.accountant, id))!;
    expect(draft).toMatchObject({ status: "draft", number: null, customerName: "Karachi Dealer", method: "cash", chequeStage: null });
    expect(draft.paid.map((p) => `${p.number} ${p.amount.toFixed(2)} ${p.counts}`)).toEqual(["SI-2627-00001 5000.00 false", "SI-2627-00002 500.00 false"]);
    expect(draft.advance.toFixed(2)).toBe("500.00");
    // A draft pays nothing yet.
    expect(await open(dealer)).toEqual(["OLD-77 1200.00 of 1200.00", "SI-2627-00001 5000.00 of 5000.00", "SI-2627-00002 3000.00 of 3000.00"]);
    await expect(postReceipt(as.recovery_officer, id, new Date(updatedAt.getTime() - 1000))).rejects.toThrow("Someone changed this receipt after you opened it.");
    expect(await postReceipt(as.recovery_officer, id, updatedAt)).toEqual({ number: "RC-2627-00001" });

    const posted = (await getReceipt(as.auditor, id))!;
    expect(posted).toMatchObject({ status: "posted", number: "RC-2627-00001" });
    expect(await journalLines(posted.journalId)).toEqual(["1111 Cash in hand: 6000 / 0", "1200 Trade receivables: 0 / 5500 (Karachi Dealer)", "2130 Advances from customers: 0 / 500 (Karachi Dealer)"]);
    expect(await open(dealer)).toEqual(["OLD-77 1200.00 of 1200.00", "SI-2627-00002 2500.00 of 3000.00"]);
    expect((await getCustomerCredit(as.owner, dealer))!.receivable.toFixed(2)).toBe("3200.00");

    // The advance is set against an invoice later: it moves from advances to the customer's account.
    await expect(applyAdvance(as.recovery_officer, id, { date: "2026-10-16", allocations: [pay(second, "500.01")] })).rejects.toThrow("This receipt has 500.00 not yet set against an invoice.");
    await expect(applyAdvance(as.recovery_officer, id, { date: "2026-10-14", allocations: [pay(second, "500")] })).rejects.toThrow("An advance is set against an invoice on or after the day it was received.");
    expect(await applyAdvance(as.accountant, id, { date: "2026-10-16", allocations: [pay(second, "300"), pay("", "0")] })).toEqual({ invoices: 1 });
    expect(await applyAdvance(as.accountant, id, { date: "2026-10-16", allocations: [pay(second, "200")] })).toEqual({ invoices: 1 });
    const applied = (await getReceipt(as.owner, id))!;
    expect(applied.paid.map((p) => `${p.number} ${p.amount.toFixed(2)} ${p.allocatedOn} ${p.later ? "from the advance" : "at posting"}`)).toEqual([
      "SI-2627-00001 5000.00 2026-10-15 at posting",
      "SI-2627-00002 500.00 2026-10-15 at posting",
      "SI-2627-00002 300.00 2026-10-16 from the advance",
      "SI-2627-00002 200.00 2026-10-16 from the advance",
    ]);
    expect(applied.advance.toFixed(2)).toBe("0.00");
    const [moved] = await admin<{ id: string }[]>`select j.id from public.journals j where j.tenant_id = ${tenantA} and j.source_type = 'advance_application' order by j.created_at, j.id limit 1`;
    expect((await journalLines(moved.id)).sort()).toEqual(["1200 Trade receivables: 0 / 300 (Karachi Dealer)", "2130 Advances from customers: 300 / 0 (Karachi Dealer)"].sort());
    expect(await open(dealer)).toEqual(["OLD-77 1200.00 of 1200.00", "SI-2627-00002 2000.00 of 3000.00"]);
    expect(`${await balance("ar", dealer)} ${await balance("customer_advances", dealer)}`).toBe("3200.00 0.00");

    // Posted: it does not change, is not posted twice and is not thrown away.
    await expect(saveReceiptDraft(as.owner, id, { ...head, allocations: [] })).rejects.toThrow("This receipt is posted and cannot be changed.");
    await expect(postReceipt(as.owner, id)).rejects.toThrow("This receipt is already posted.");
    await expect(discardReceipt(as.owner, id)).rejects.toThrow("This receipt is posted and cannot be removed.");
    expect((await listReceipts(as.auditor)).rows.map((r) => `${r.number} ${r.customerName} ${r.amount.toFixed(2)} ${r.status}`)).toEqual(["RC-2627-00001 Karachi Dealer 6000.00 posted"]);
  });

  it("posts a bank receipt with what the bank kept, and takes a receipt entered by mistake back", async () => {
    const draft = await saveReceiptDraft(as.accountant, null, { date: "2026-10-14", customerId: rider, method: "bank", accountId: bank, amount: "2000", bankCharges: "50", reference: "IBFT 88213", allocations: [pay(third, "2000")] });
    expect(await postReceipt(as.accountant, draft.id)).toEqual({ number: "RC-2627-00002" });
    const posted = (await getReceipt(as.accountant, draft.id))!;
    expect(await journalLines(posted.journalId)).toEqual(["1121 HBL current account: 1950 / 0", "5810 Bank charges: 50 / 0", "1200 Trade receivables: 0 / 2000 (Walk-in Rider)"]);
    expect(await open(rider)).toEqual([]);

    // It was the wrong customer's money: cancelled, with the reason, on or after its date.
    await expect(cancelReceipt(as.accountant, draft.id, { date: "2026-10-13", reason: "Wrong customer" })).rejects.toThrow("A receipt is cancelled on or after its own date.");
    await expect(cancelReceipt(as.accountant, draft.id, { date: "2026-10-15", reason: "x" })).rejects.toThrow("Say why the receipt is cancelled");
    await expect(cancelReceipt(as.auditor, draft.id, { date: "2026-10-15", reason: "Wrong customer" })).rejects.toThrow("Only an owner, an accountant or the recovery officer can record receipts.");
    await cancelReceipt(as.accountant, draft.id, { date: "2026-10-15", reason: "Wrong customer" });
    const cancelled = (await getReceipt(as.accountant, draft.id))!;
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Wrong customer", number: "RC-2627-00002" });
    expect(cancelled.paid.map((p) => `${p.number} ${p.counts}`)).toEqual(["SI-2627-00003 false"]);
    const reversal = await reversalOf(posted.journalId);
    expect(reversal.journal_date).toBe("2026-10-15");
    expect(await journalLines(reversal.id)).toEqual(["1121 HBL current account: 0 / 1950", "5810 Bank charges: 0 / 50", "1200 Trade receivables: 2000 / 0 (Walk-in Rider)"]);
    expect(await open(rider)).toEqual(["SI-2627-00003 2000.00 of 2000.00"]);
    expect(await balance("ar", rider)).toBe("2000.00");
    await expect(cancelReceipt(as.accountant, draft.id, { date: "2026-10-15", reason: "Wrong customer" })).rejects.toThrow("This receipt has already been taken back.");
    expect(await codeOf(as.accountant, sql`select app.cancel_receipt(${draft.id}, '2026-10-15', 'Again, by hand')`)).toBe("SE101");
  });

  it("takes a cheque from in hand to the bank, and restores the invoice when it bounces", async () => {
    const head = { date: "2026-10-16", customerId: dealer, method: "cheque", amount: "2000" };
    await expect(saveReceiptDraft(as.recovery_officer, null, { ...head, allocations: [] })).rejects.toThrow("Enter the cheque number");
    const draft = await saveReceiptDraft(as.recovery_officer, null, { ...head, chequeNumber: "00451872", chequeBank: "Meezan Bank", chequeDate: "2026-10-20", allocations: [pay(second, "2000")] });
    expect(await postReceipt(as.recovery_officer, draft.id)).toEqual({ number: "RC-2627-00003" });
    let cheque = (await getReceipt(as.recovery_officer, draft.id))!;
    // Received: the invoice is paid, and the cheque is an asset in hand.
    expect(cheque).toMatchObject({ status: "posted", chequeStage: "received", accountId: null });
    expect(await journalLines(cheque.journalId)).toEqual(["1130 Cheques in hand: 2000 / 0", "1200 Trade receivables: 0 / 2000 (Karachi Dealer)"]);
    expect(await open(dealer)).toEqual(["OLD-77 1200.00 of 1200.00"]);
    const register = await listCheques(as.recovery_officer);
    expect(register.rows.map((r) => `${r.chequeNumber} ${r.chequeBank} ${r.chequeDate} ${r.chequeStage} ${r.amount.toFixed(2)}`)).toEqual(["00451872 Meezan Bank 2026-10-20 received 2000.00"]);
    expect(`${register.inHand.toFixed(2)} ${register.deposited.toFixed(2)} ${await balance("cheques_in_hand")}`).toBe("2000.00 0.00 2000.00");

    // Deposited: not before the date written on it, and into a bank account. Nothing is posted.
    await expect(depositCheque(as.recovery_officer, draft.id, { accountId: bank, date: "2026-10-18" })).rejects.toThrow("not before the date written on it");
    await expect(depositCheque(as.recovery_officer, draft.id, { accountId: cash, date: "2026-10-20" })).rejects.toThrow("Choose a cash account for cash, or a bank account");
    await expect(clearCheque(as.recovery_officer, draft.id, { date: "2026-10-20" })).rejects.toThrow("Only a cheque that has been deposited can be marked cleared.");
    await depositCheque(as.recovery_officer, draft.id, { accountId: bank, date: "2026-10-20" });
    cheque = (await getReceipt(as.recovery_officer, draft.id))!;
    expect(cheque).toMatchObject({ chequeStage: "deposited", accountId: bank, depositedOn: "2026-10-20" });
    expect(`${await balance("cheques_in_hand")} ${(await listCheques(as.owner)).deposited.toFixed(2)}`).toBe("2000.00 2000.00");
    // A cheque that has gone to the bank clears or bounces; it is not cancelled.
    await expect(cancelReceipt(as.owner, draft.id, { date: "2026-10-21", reason: "Entered twice" })).rejects.toThrow("This cheque has gone to the bank.");

    // Cleared: the bank has the money, less the 25 it kept.
    await expect(clearCheque(as.recovery_officer, draft.id, { date: "2026-10-19" })).rejects.toThrow("A cheque clears on or after the day it was deposited.");
    await clearCheque(as.recovery_officer, draft.id, { date: "2026-10-22", bankCharges: "25" });
    cheque = (await getReceipt(as.owner, draft.id))!;
    expect(cheque).toMatchObject({ chequeStage: "cleared", clearedOn: "2026-10-22" });
    const [clearance] = await admin<{ id: string; clearance_journal_id: string }[]>`select id, clearance_journal_id from public.receipts where id = ${draft.id}`;
    expect(await journalLines(clearance.clearance_journal_id)).toEqual(["1121 HBL current account: 1975 / 0", "5810 Bank charges: 25 / 0", "1130 Cheques in hand: 0 / 2000"]);
    expect(`${await balance("cheques_in_hand")} ${(await listCheques(as.owner)).rows.length}`).toBe("0.00 0");

    // Bounced after all: everything is taken back and the invoice is unpaid again.
    await expect(bounceCheque(as.recovery_officer, draft.id, { date: "2026-10-21", reason: "Insufficient funds" })).rejects.toThrow("A cheque bounces on or after the last thing that happened to it.");
    await bounceCheque(as.recovery_officer, draft.id, { date: "2026-10-25", reason: "Insufficient funds" });
    cheque = (await getReceipt(as.auditor, draft.id))!;
    expect(cheque).toMatchObject({ status: "bounced", chequeStage: "bounced", bouncedOn: "2026-10-25", bounceReason: "Insufficient funds", number: "RC-2627-00003" });
    expect(await journalLines((await reversalOf(cheque.journalId)).id)).toEqual(["1130 Cheques in hand: 0 / 2000", "1200 Trade receivables: 2000 / 0 (Karachi Dealer)"]);
    // It had cleared, so the bank takes the whole cheque back out of the account and keeps the 25 it charged: the clearance is not reversed.
    expect(await reversalOf(clearance.clearance_journal_id)).toBeUndefined();
    const [returned] = await admin<{ id: string; journal_date: string }[]>`select id, journal_date::text from public.journals where source_type = 'cheque_return' and source_id = ${draft.id}`;
    expect(returned.journal_date).toBe("2026-10-25");
    expect(await journalLines(returned.id)).toEqual(["1130 Cheques in hand: 2000 / 0", "1121 HBL current account: 0 / 2000"]);
    expect(`${await balance("bank")} ${await balance("bank_charges")}`).toBe("-25.00 25.00");
    expect(await open(dealer)).toEqual(["OLD-77 1200.00 of 1200.00", "SI-2627-00002 2000.00 of 3000.00"]);
    expect(`${await balance("ar", dealer)} ${await balance("cheques_in_hand")}`).toBe("3200.00 0.00");
    const [logged] = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'cheque.bounce' and entity_id = ${draft.id}`;
    expect(logged).toMatchObject({ actor_role: "recovery_officer", after: { number: "RC-2627-00003", reason: "Insufficient funds", unpaidAgain: "SI-2627-00002" } });
    // Final: a bounced receipt does nothing more. When the customer pays again, that is a new receipt.
    for (const again of [() => bounceCheque(as.owner, draft.id, { date: "2026-10-26", reason: "Twice" }), () => depositCheque(as.owner, draft.id, { accountId: bank, date: "2026-10-26" }), () => applyAdvance(as.owner, draft.id, { date: "2026-10-26", allocations: [pay(second, "1")] })]) {
      await expect(again()).rejects.toThrow();
    }

    // A cheque still in hand bounces the same way, and one entered by mistake is cancelled while in hand.
    const inHand = await saveReceiptDraft(as.owner, null, { ...head, date: "2026-10-26", amount: "1500", chequeNumber: "00451873", chequeBank: "Meezan Bank", chequeDate: "2026-10-26", allocations: [pay(second, "1000")] });
    await postReceipt(as.owner, inHand.id);
    expect(`${await balance("customer_advances", dealer)} ${await balance("cheques_in_hand")}`).toBe("-500.00 1500.00");
    await bounceCheque(as.owner, inHand.id, { date: "2026-10-27", reason: "Signature differs" });
    expect(`${await balance("customer_advances", dealer)} ${await balance("cheques_in_hand")} ${await balance("ar", dealer)}`).toBe("0.00 0.00 3200.00");
    const mistake = await saveReceiptDraft(as.owner, null, { ...head, date: "2026-10-26", amount: "700", chequeNumber: "00451874", chequeBank: "Meezan Bank", chequeDate: "2026-10-26", allocations: [pay(second, "700")] });
    await postReceipt(as.owner, mistake.id);
    await cancelReceipt(as.owner, mistake.id, { date: "2026-10-26", reason: "Entered twice" });
    expect(await getReceipt(as.owner, mistake.id)).toMatchObject({ status: "cancelled", chequeStage: "received" });
    expect((await listCheques(as.owner, true)).rows.map((r) => `${r.chequeNumber} ${r.status}`)).toEqual(["00451872 bounced", "00451873 bounced", "00451874 cancelled"]);
    expect(await open(dealer)).toEqual(["OLD-77 1200.00 of 1200.00", "SI-2627-00002 2000.00 of 3000.00"]);
  });

  it("pays an invoice brought in with the opening balances, which then cannot be reversed", async () => {
    const [old] = await admin<{ id: string }[]>`select b.id from public.opening_balances b where b.tenant_id = ${tenantA} and b.document_number = 'OLD-77'`;
    const draft = await saveReceiptDraft(as.recovery_officer, null, { date: "2026-10-17", customerId: dealer, method: "cash", accountId: cash, amount: "700", allocations: [pay(old.id, "700", "opening")] });
    expect(await postReceipt(as.recovery_officer, draft.id)).toEqual({ number: expect.stringMatching(/^RC-2627-/) });
    expect(await open(dealer)).toEqual(["OLD-77 500.00 of 1200.00", "SI-2627-00002 2000.00 of 3000.00"]);
    expect((await getReceipt(as.recovery_officer, draft.id))!.paid.map((p) => `${p.kind} ${p.number} ${p.amount.toFixed(2)}`)).toEqual(["opening OLD-77 700.00"]);
    // The opening balances a receipt has been set against stay: reversing them would leave the receipt paying nothing.
    const refused = await reverseOpening(as.owner).then(
      () => "reversed",
      (error: { code?: string; cause?: { code?: string } }) => error.cause?.code ?? error.code,
    );
    expect(refused).toBe("SE109");
    expect((await admin`select status from public.opening_entries where tenant_id = ${tenantA}`)[0].status).toBe("posted");
    expect(await balance("ar", dealer)).toBe("2500.00");
  });

  it("lets the app's role write nothing that only the posting functions may write", async () => {
    const draft = await saveReceiptDraft(as.owner, null, { date: "2026-10-18", customerId: dealer, method: "cash", accountId: cash, amount: "100", allocations: [] });
    const [posted] = await admin<{ id: string; journal_id: string }[]>`select id, journal_id from public.receipts where tenant_id = ${tenantA} and number = 'RC-2627-00001'`;
    // The status, the number, the journals and where a cheque stands are closed to the app.
    expect(await codeOf(as.owner, sql`update public.receipts set status = 'posted', number = 'RC-2627-00099', journal_id = ${posted.journal_id}, posted_at = now(), posted_by = ${userIds.owner} where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.receipts set cheque_status = 'cleared' where id = ${draft.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`insert into public.receipts (tenant_id, status, receipt_date, customer_id, method, account_id, amount, created_by, updated_by) values (${tenantA}, 'posted', '2026-10-18', ${dealer}, 'cash', ${cash}, 5, ${userIds.owner}, ${userIds.owner})`)).toBe("SE101");
    // A posted receipt and what it pays stay as they are.
    await withTenant(as.owner.userId, tenantA, (tx) => tx.execute(sql`update public.receipts set amount = 1, note = 'changed' where id = ${posted.id}`));
    await withTenant(as.owner.userId, tenantA, (tx) => tx.execute(sql`delete from public.receipts where id = ${posted.id}`));
    await withTenant(as.owner.userId, tenantA, (tx) => tx.execute(sql`delete from public.receipt_allocations where receipt_id = ${posted.id}`));
    expect(await getReceipt(as.owner, posted.id)).toMatchObject({ status: "posted", note: "Collected at the shop", paid: [{}, {}, {}, {}] });
    expect(await codeOf(as.owner, sql`insert into public.receipt_allocations (tenant_id, receipt_id, invoice_id, amount, created_by) values (${tenantA}, ${posted.id}, ${second}, 1, ${userIds.owner})`)).toBe("SE105");
    // A row names a posted invoice of the receipt's own customer; anything else is refused in the same
    // words, whether it is another customer's invoice, a sales order, or not there at all.
    const [anOrder] = await admin<{ id: string }[]>`select id from public.sales_documents where tenant_id = ${tenantA} and kind = 'order' limit 1`;
    const name = (target: string) => codeOf(as.owner, sql`insert into public.receipt_allocations (tenant_id, receipt_id, invoice_id, amount, created_by) values (${tenantA}, ${draft.id}, ${target}, 1, ${userIds.owner})`);
    expect([await name(third), await name(anOrder.id), await name(randomUUID())]).toEqual(["SE102", "SE102", "SE102"]);
    // A draft that names invoices keeps its customer.
    expect(await name(second)).toBeUndefined();
    expect(await codeOf(as.owner, sql`update public.receipts set customer_id = ${rider}, updated_by = ${userIds.owner} where id = ${draft.id}`)).toBe("SE102");
    await withTenant(as.owner.userId, tenantA, (tx) => tx.execute(sql`delete from public.receipt_allocations where receipt_id = ${draft.id}`));
    // What a bank keeps on a cheque is said when it clears, never before.
    expect(await codeOf(as.owner, sql`insert into public.receipts (tenant_id, receipt_date, customer_id, method, amount, bank_charges, cheque_number, cheque_bank, cheque_date, created_by, updated_by)
      values (${tenantA}, '2026-10-18', ${dealer}, 'cheque', 100, 40, '1', 'HBL', '2026-10-18', ${userIds.owner}, ${userIds.owner})`)).toBe("23514");
    // What counts, and from when, is not the app's to say, on a draft or anywhere.
    expect(await codeOf(as.owner, sql`insert into public.receipt_allocations (tenant_id, receipt_id, invoice_id, amount, posted_at, allocated_on, created_by) values (${tenantA}, ${draft.id}, ${second}, 1, now(), '2026-10-18', ${userIds.owner})`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.receipt_allocations set voided_at = now() where receipt_id = ${posted.id}`)).toBe("42501");
    // The functions behind the posting, and journals of these kinds, are not the app's to call or write.
    expect(await codeOf(as.owner, sql`select app.receivable_items(${tenantA}, ${dealer})`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.hold_receipt(${draft.id})`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.reverse_receipt_journal(${posted.journal_id}, '2026-10-18', 'by hand')`)).toBe("42501");
    expect(await codeOf(as.owner, sql`select app.undo_receipt(r, '2026-10-18', 'by hand') from public.receipts r where r.id = ${posted.id}`)).toBe("42501");
    for (const source of ["receipt", "cheque_clearance", "advance_application"]) {
      expect(await codeOf(as.owner, sql`select app.post_journal('2026-10-18'::date, ${source}, ${randomUUID()}, '[]'::jsonb)`), source).toBe("23514");
    }
    for (const action of ["receipt.post", "receipt.cancel", "receipt.apply_advance", "cheque.deposit", "cheque.clear", "cheque.bounce"]) {
      expect(await codeOf(as.owner, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity) values (${tenantA}, ${userIds.owner}, 'owner', ${action}, 'x')`), action).toBe("42501");
    }
    // Those who do not record receipts cannot post one, whatever they call.
    for (const role of ["salesperson", "sales_manager", "auditor", "warehouse_manager"] as const) {
      expect(await codeOf(as[role], sql`select app.post_receipt(${draft.id})`), role).toBe("42501");
      expect(await codeOf(as[role], sql`select app.bounce_cheque(${posted.id}, '2026-10-18', 'by hand')`), role).toBe("42501");
    }
    // A member of one branch has that branch's receipts and no others; another company has none.
    expect(await getReceipt(collector, posted.id)).toBeNull();
    expect(await codeOf(collector, sql`select app.post_receipt(${draft.id})`)).toBe("SE100");
    await expect(saveReceiptDraft(collector, null, { date: "2026-10-18", customerId: dealer, method: "cash", accountId: cash, amount: "100", allocations: [] })).rejects.toThrow("Choose the branch the receipt belongs to.");
    // What a member of the City branch is shown of a customer's debt is the City branch's invoices: here, none.
    expect(await open(dealer, collector)).toEqual([]);
    await expect(saveReceiptDraft(collector, null, { date: "2026-10-18", customerId: dealer, method: "cash", accountId: cash, amount: "100", branchId: cityBranch, allocations: [pay(second, "100")] })).rejects.toThrow("not an unpaid invoice of this customer");
    const own = await saveReceiptDraft(collector, null, { date: "2026-10-18", customerId: dealer, method: "cash", accountId: cash, amount: "100", branchId: cityBranch, allocations: [] });
    expect(await codeOf(collector, sql`insert into public.receipt_allocations (tenant_id, receipt_id, invoice_id, amount, created_by) values (${tenantA}, ${own.id}, ${second}, 1, ${cityCollector})`)).toBe("SE102");
    expect((await listReceipts(collector)).rows.length).toBe(1);
    await discardReceipt(collector, own.id);
    expect(await getReceipt(otherOwner, posted.id)).toBeNull();
    expect(await codeOf(otherOwner, sql`select app.post_receipt(${draft.id})`)).toBe("SE100");
    // A line slipped into a receipt the member cannot write is refused the same way whether it is a draft, posted or not there.
    const slip = (receiptId: string) => codeOf(collector, sql`insert into public.receipt_allocations (tenant_id, receipt_id, invoice_id, amount, created_by) values (${tenantA}, ${receiptId}, ${second}, 1, ${cityCollector})`);
    expect([await slip(draft.id), await slip(posted.id), await slip(randomUUID())]).toEqual(["42501", "42501", "42501"]);
    // Nothing is recorded before it happens: a receipt dated next year is not posted.
    await saveReceiptDraft(as.owner, draft.id, { date: "2027-03-01", customerId: dealer, method: "cash", accountId: cash, amount: "100", allocations: [] });
    await expect(postReceipt(as.owner, draft.id)).rejects.toThrow("That date has not come yet.");
    await saveReceiptDraft(as.owner, draft.id, { date: "2026-10-18", customerId: dealer, method: "cash", accountId: cash, amount: "100", allocations: [] });
    // "Today" is Pakistan's day, not whatever the session says its time zone is: tomorrow there is still tomorrow.
    const tomorrow = todayIso(new Date(Date.now() + 24 * 60 * 60 * 1000));
    await saveReceiptDraft(as.owner, draft.id, { date: tomorrow, customerId: dealer, method: "cash", accountId: cash, amount: "100", allocations: [] });
    expect(await codeOf(as.owner, sql`select set_config('timezone', 'Pacific/Kiritimati', true), app.post_receipt(${draft.id})`)).toBe("SE111");
    await saveReceiptDraft(as.owner, draft.id, { date: "2026-10-18", customerId: dealer, method: "cash", accountId: cash, amount: "100", allocations: [] });
    // Someone who works across the company can set a Main invoice against a City receipt; the City
    // collector then sees the amount on that receipt, not which invoice it is.
    const mixed = await saveReceiptDraft(as.owner, null, { date: "2026-10-18", customerId: dealer, method: "cash", accountId: cash, amount: "100", branchId: cityBranch, allocations: [pay(second, "1")] });
    expect((await getReceipt(as.owner, mixed.id))!.paid.map((p) => `${p.number} ${p.amount.toFixed()}`)).toEqual(["SI-2627-00002 1"]);
    expect((await getReceipt(collector, mixed.id))!.paid.map((p) => `${p.number} ${p.date} ${p.amount.toFixed()}`)).toEqual(["null null 1"]);
    await discardReceipt(as.owner, mixed.id);
    // A cheque is not cleared into a bank account that has been archived since it was deposited there: the account is restored first.
    const held = await saveReceiptDraft(as.owner, null, { date: "2026-10-18", customerId: dealer, method: "cheque", amount: "60", chequeNumber: "00451880", chequeBank: "Meezan Bank", chequeDate: "2026-10-18", allocations: [] });
    await postReceipt(as.owner, held.id);
    await depositCheque(as.owner, held.id, { accountId: bank, date: "2026-10-19" });
    await admin`update public.accounts set archived_at = now(), archived_by = ${userIds.owner} where id = ${bank}`;
    await expect(clearCheque(as.owner, held.id, { date: "2026-10-20" })).rejects.toThrow("An archived account cannot be used: restore it first");
    expect(await getReceipt(as.owner, held.id)).toMatchObject({ chequeStage: "deposited", clearedOn: null });
    await admin`update public.accounts set archived_at = null, archived_by = null where id = ${bank}`;
    await bounceCheque(as.owner, held.id, { date: "2026-10-20", reason: "Only for this test" });
    // Posting is refused outside the kind of transaction its checks were written for.
    expect(["SE107", "25001"]).toContain(await codeOf(as.owner, sql`select set_config('transaction_isolation', 'repeatable read', true), app.post_receipt(${draft.id})`));
    await discardReceipt(as.owner, draft.id);
  });

  it("lets only one of two receipts for the last of an invoice through, and keeps the books to what the invoices show", async () => {
    // Two receipts, each for the 2,000 still unpaid on the second invoice, posted at the same moment.
    const drafts = await Promise.all([1, 2].map(() => saveReceiptDraft(as.owner, null, { date: "2026-10-28", customerId: dealer, method: "cash", accountId: cash, amount: "2000", allocations: [pay(second, "2000")] })));
    const results = await Promise.allSettled(drafts.map((draft) => postReceipt(as.owner, draft.id)));
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("One of the invoices cannot take that much");
    expect(await open(dealer)).toEqual(["OLD-77 500.00 of 1200.00"]);
    await discardReceipt(as.owner, drafts[results[0].status === "rejected" ? 0 : 1].id);

    // An advance is set against an invoice once, however the invoice's id is written: in capitals it is the same invoice.
    const spare = await saveReceiptDraft(as.owner, null, { date: "2026-10-28", customerId: dealer, method: "cash", accountId: cash, amount: "1000", allocations: [] });
    await postReceipt(as.owner, spare.id);
    const [old] = await admin<{ id: string }[]>`select b.id from public.opening_balances b where b.tenant_id = ${tenantA} and b.document_number = 'OLD-77'`;
    const twice = JSON.stringify([{ opening_balance_id: old.id.toLowerCase(), amount: "500" }, { opening_balance_id: old.id.toUpperCase(), amount: "500" }]);
    expect(await codeOf(as.owner, sql`select app.apply_receipt_advance(${spare.id}, '2026-10-28', ${twice}::jsonb)`)).toBe("23514");
    expect(await open(dealer)).toEqual(["OLD-77 500.00 of 1200.00"]);
    await cancelReceipt(as.owner, spare.id, { date: "2026-10-28", reason: "Only for this test" });

    // After everything: what each customer's account stands at in the books is what their unpaid
    // invoices come to; advances are what standing receipts hold beyond invoices; and Cheques in
    // hand is the cheques that stand and have not cleared.
    for (const [customerId, owed] of [[dealer, "500.00"], [rider, "2000.00"]] as const) {
      const items = await listOpenItems(as.owner, customerId);
      expect(items.reduce((sum, item) => sum + Number(item.outstanding.toFixed(2)), 0).toFixed(2)).toBe(owed);
      expect(await balance("ar", customerId)).toBe(owed);
      expect(await balance("customer_advances", customerId)).toBe("0.00");
    }
    expect(await balance("cheques_in_hand")).toBe("0.00");
    // Every journal a receipt wrote balances and belongs to a receipt; the count is what the scenarios posted.
    const [journals] = await admin`select count(*) filter (where source_type = 'receipt')::int as receipts, count(*) filter (where source_type = 'cheque_clearance')::int as clearances,
      count(*) filter (where source_type = 'advance_application')::int as applications from public.journals where tenant_id = ${tenantA}`;
    expect(journals).toEqual({ receipts: 9, clearances: 1, applications: 2 });
  });
});
