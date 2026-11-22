import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant, type Tx } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postCreditNote, saveCreditNoteDraft, startCreditNote } from "@/modules/credit-notes/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { applyAdvance, cancelReceipt, postReceipt, postReceiptIn, saveReceiptDraft, saveReceiptDraftIn } from "@/modules/receipts/commands";
import { findCustomers, listOpenItems } from "@/modules/receipts/queries";
import { postInvoice, postInvoiceIn, saveInvoiceDraft, saveSalesDraft, saveSalesDraftIn, startInvoice, startInvoiceIn, submitIn, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument, searchCustomers } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { enterAs } from "../../../tests/support/identity";
import { postCounterSale } from "./commands";
import { getCounterSaleOfInvoice } from "./queries";

// Step 22 against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): a counter sale makes the order, the invoice and the receipt at once;
// the walk-in customer is sold to in no other way and never owes anything; and the step's
// acceptance, an advance set against an invoice clears both. Skipped when the database URLs
// are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-counter-test";
const tenantA = randomUUID();
const roles = ["owner", "accountant", "auditor", "recovery_officer", "sales_manager", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const mainBranch = randomUUID();
const mainWarehouse = randomUUID();
const ctx = (userId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@counter.test`, tenantId: tenantA, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const OPENED = "2026-10-01";
const DAY = "2026-10-20";

let admin: AdminSql;
let helmet: string;
let dealer: string;
let cash: string;
let bank: string;

/** The database's code for what this member's work was refused with, or undefined when it went through. */
async function refusedWith(who: TenantContext, work: (tx: Tx) => Promise<unknown>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, work);
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const codeOf = (who: TenantContext, statement: ReturnType<typeof sql>) => refusedWith(who, (tx) => tx.execute(statement));
const line = (quantity: string, unitPrice = "") => ({ itemId: helmet, quantity, unitId: "", unitPrice, discountPercent: "" });
const sale = (over: Record<string, unknown> = {}) => ({ date: DAY, warehouseId: mainWarehouse, buyerName: "Bilal Ahmed", buyerPhone: "0300 1234567", lines: [line("2")], shares: [], method: "cash", accountId: cash, ...over });
const journalLines = async (sourceId: string, sourceType: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || a.name || ': ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text || coalesce(' (' || c.name || ')', '') as line
      from public.journals j join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id left join public.customers c on c.id = l.customer_id
      where j.tenant_id = ${tenantA} and j.source_id = ${sourceId} and j.source_type = ${sourceType} order by l.line_no`
  ).map((row) => row.line);
async function balance(control: string, customerId: string): Promise<string> {
  const [row] = await admin`
    select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.tenant_id = ${tenantA} and a.control_type = ${control} and l.customer_id = ${customerId}`;
  return row.v;
}
const onHand = async () => (await admin<{ q: string }[]>`select trim_scale(quantity)::text as q from public.stock_balances where tenant_id = ${tenantA} and item_id = ${helmet} and warehouse_id = ${mainWarehouse}`)[0].q;
const counts = async () =>
  (
    await admin<{ v: string }[]>`
      select (select count(*) from public.sales_documents where tenant_id = ${tenantA})::text || ' documents, '
        || (select count(*) from public.receipts where tenant_id = ${tenantA})::text || ' receipts, '
        || (select count(*) from public.counter_sales where tenant_id = ${tenantA})::text || ' counter sales' as v`
  )[0].v;
/** A session of the app's own role, signed in as someone, inside a transaction left open: for two at once. */
async function appSession(userId: string) {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const tx = await client.reserve();
  await tx`begin`;
  await enterAs(tx, userId, tenantA);
  return {
    tx,
    end: async () => {
      tx.release();
      await client.end();
    },
  };
}
const walkIn = async () => (await admin<{ id: string }[]>`select customer_id as id from public.walk_in_customers where tenant_id = ${tenantA}`)[0]?.id;

/**
 * A counter sale made by hand, past postCounterSale, as far as `upTo` and then committed: to show
 * the database itself refuses one left without its receipt, or paid in part.
 */
async function byHand(upTo: "invoice" | "part-paid"): Promise<string | undefined> {
  return refusedWith(as.owner, async (tx) => {
    const [walk] = await tx.execute<{ id: string }>(sql`select app.walk_in_customer() as id`);
    const draft = await saveSalesDraftIn(tx, as.owner, null, {
      kind: "order",
      date: DAY,
      validUntil: null,
      customerId: walk.id,
      warehouseId: mainWarehouse,
      customerReference: null,
      notes: null,
      furtherTaxExcluded: false,
      lines: [{ itemId: helmet, description: null, unitId: null, quantity: new Decimal(1), unitPrice: null, discountPercent: null }],
      shares: [],
    });
    await tx.execute(sql`insert into public.counter_sales (tenant_id, order_id, buyer_name, client_key, created_by) values (${tenantA}, ${draft.id}, 'By Hand', gen_random_uuid(), ${userIds.owner})`);
    await submitIn(tx, as.owner, draft.id, undefined, {});
    const invoice = await startInvoiceIn(tx, as.owner, draft.id, DAY);
    await tx.execute(sql`update public.counter_sales set invoice_id = ${invoice.id} where order_id = ${draft.id}`);
    await postInvoiceIn(tx, as.owner, invoice.id);
    if (upTo === "invoice") return;
    const one = new Decimal(1);
    const receipt = await saveReceiptDraftIn(tx, as.owner, null, { date: DAY, customerId: walk.id, method: "cash", accountId: cash, amount: one, bankCharges: new Decimal(0), reference: null, note: null, branchId: null, cheque: null, allocations: [{ kind: "invoice", id: invoice.id, amount: one }] });
    await tx.execute(sql`update public.counter_sales set receipt_id = ${receipt.id} where order_id = ${draft.id}`);
    await postReceiptIn(tx, receipt.id);
  });
}

describe.skipIf(!hasDb)("counter sales", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainWarehouse}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin(roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })))}`;
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
    // A customer already called what the walk-in customer would be called: the walk-in customer takes the next name.
    await createParty(as.owner, "customer", { name: "Walk-in customer", code: "C-002" });
    const stock = await saveAdjustmentDraft(as.owner, "opening", null, { date: OPENED, warehouseId: mainWarehouse, lines: [{ itemCode: "HL-1", direction: "in", quantity: "100", unitCost: "600" }] });
    await postAdjustment(as.owner, stock.id);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("makes the order, the invoice and the receipt at once: the goods leave stock and the buyer owes nothing", async () => {
    const made = await postCounterSale(as.owner, sale());
    expect(made).toMatchObject({ invoiceNumber: "SI-2627-00001", receiptNumber: "RC-2627-00001" });
    expect(made.total).toBe("2000.0000");
    const customer = await walkIn();
    expect((await admin<{ name: string }[]>`select name from public.customers where id = ${customer}`)[0].name).toBe("Walk-in customer 2");

    const invoice = (await getSalesDocument(as.owner, made.invoiceId))!;
    expect([invoice.status, invoice.customerName, invoice.date, invoice.dueDate]).toEqual(["submitted", "Bilal Ahmed", DAY, DAY]);
    const [order] = await admin<{ number: string; buyer_name: string; status: string }[]>`select number, buyer_name, status from public.sales_documents where id = ${invoice.source!.id}`;
    expect(order).toEqual({ number: "SO-2627-00001", buyer_name: "Bilal Ahmed", status: "submitted" });

    // Sold on credit for a moment, and paid in the same breath: the walk-in customer's account is back at nothing.
    expect(await journalLines(made.invoiceId, "sales_invoice")).toEqual([
      "1200 Trade receivables: 2000 / 0 (Walk-in customer 2)",
      "4100 Sales: 0 / 2000",
      "5100 Cost of goods sold: 1200 / 0",
      "1300 Stock in trade: 0 / 1200",
    ]);
    const [receipt] = await admin<{ id: string; method: string; amount: string }[]>`select id, method, trim_scale(amount)::text as amount from public.receipts where tenant_id = ${tenantA} and number = 'RC-2627-00001'`;
    expect(await journalLines(receipt.id, "receipt")).toEqual(["1111 Cash in hand: 2000 / 0", "1200 Trade receivables: 0 / 2000 (Walk-in customer 2)"]);
    expect(await balance("ar", customer)).toBe("0.00");
    expect(await listOpenItems(as.accountant, customer)).toEqual([]);
    expect(await onHand()).toBe("98");

    const view = await getCounterSaleOfInvoice(as.owner, made.invoiceId);
    expect(view).toEqual({ buyerName: "Bilal Ahmed", buyerPhone: "0300 1234567", receipt: { id: receipt.id, number: "RC-2627-00001", method: "cash" } });
    // A salesperson does not read receipts: the sale shows as paid, without the receipt.
    expect((await getCounterSaleOfInvoice(as.salesperson, made.invoiceId))?.receipt ?? null).toBeNull();
    const [audit] = await admin<{ actor_role: string; after: { buyer: string; invoice: string; receipt: string } }[]>`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'counter_sale.post'`;
    expect(audit.actor_role).toBe("owner");
    expect(audit.after).toMatchObject({ buyer: "Bilal Ahmed", invoice: "SI-2627-00001", receipt: "RC-2627-00001" });
  });

  it("uses the same walk-in customer every time, and takes a bank payment", async () => {
    const before = await walkIn();
    const made = await postCounterSale(as.accountant, sale({ buyerName: "  Sara   Khan ", buyerPhone: "", method: "bank", accountId: bank, reference: "Card 4411", lines: [line("1", "1250")] }));
    expect(made.receiptNumber).toBe("RC-2627-00002");
    expect(await walkIn()).toBe(before);
    expect((await admin<{ n: number }[]>`select count(*)::int as n from public.walk_in_customers where tenant_id = ${tenantA}`)[0].n).toBe(1);
    const view = (await getCounterSaleOfInvoice(as.owner, made.invoiceId))!;
    expect([view.buyerName, view.buyerPhone, view.receipt?.method]).toEqual(["Sara Khan", null, "bank"]);
    const [receipt] = await admin<{ id: string; reference: string }[]>`select id, reference from public.receipts where tenant_id = ${tenantA} and number = 'RC-2627-00002'`;
    expect(receipt.reference).toBe("Card 4411");
    expect(await journalLines(receipt.id, "receipt")).toEqual(["1121 HBL current account: 1250 / 0", "1200 Trade receivables: 0 / 1250 (Walk-in customer 2)"]);
    expect(await balance("ar", before)).toBe("0.00");
  });

  it("makes nothing when any part of it is refused", async () => {
    const before = await counts();
    await expect(postCounterSale(as.owner, sale({ lines: [line("500")] }))).rejects.toThrow("Not enough HL-1 in stock at Main store");
    await expect(postCounterSale(as.owner, sale({ accountId: bank }))).rejects.toThrow();
    expect(await counts()).toBe(before);
    expect(await onHand()).toBe("97");
  });

  it("is never left unpaid or paid in part, even when made past the app", async () => {
    const before = await counts();
    expect(await byHand("invoice")).toBe("SE123");
    expect(await byHand("part-paid")).toBe("SE122");
    expect(await counts()).toBe(before);
  });

  it("records a sale sent twice once", async () => {
    const clientKey = randomUUID();
    const first = await postCounterSale(as.owner, sale({ clientKey, buyerName: "Twice Sent" }));
    const before = await counts();
    const again = await postCounterSale(as.owner, sale({ clientKey, buyerName: "Twice Sent" }));
    expect(again).toEqual(first);
    expect(await counts()).toBe(before);
  });

  it("reads what was typed, and says what is wrong", async () => {
    await expect(postCounterSale(as.owner, sale({ buyerName: " " }))).rejects.toThrow("Enter the buyer's name.");
    await expect(postCounterSale(as.owner, sale({ buyerPhone: "call me" }))).rejects.toThrow("Enter the buyer's phone as digits");
    await expect(postCounterSale(as.owner, sale({ method: "cheque" }))).rejects.toThrow("Choose how the buyer paid: in cash, or into a bank account.");
    await expect(postCounterSale(as.owner, sale({ lines: [] }))).rejects.toThrow("Enter at least one line");
    await expect(postCounterSale(as.owner, sale({ date: "2099-01-01" }))).rejects.toThrow("never before it");
  });

  it("is for the owner and an accountant, who take the money as they sell", async () => {
    for (const role of ["sales_manager", "salesperson", "recovery_officer", "auditor"] as const) {
      await expect(postCounterSale(as[role], sale()), role).rejects.toThrow("Only the owner or an accountant sells at the counter");
      expect(await codeOf(as[role], sql`select app.walk_in_customer()`), role).toBe("42501");
    }
    const [order] = await admin<{ order_id: string }[]>`select order_id from public.counter_sales where tenant_id = ${tenantA} limit 1`;
    // Refused by the row's own check (the order is no longer a draft) before the policy is asked; either way, refused.
    expect(["42501", "SE122"]).toContain(await codeOf(as.sales_manager, sql`insert into public.counter_sales (tenant_id, order_id, buyer_name, created_by) values (${tenantA}, ${order.order_id}, 'Someone', ${userIds.sales_manager})`));
  });

  it("is written once and never changed or removed", async () => {
    const [row] = await admin<{ id: string; invoice_id: string }[]>`select id, invoice_id from public.counter_sales where tenant_id = ${tenantA} order by created_at limit 1`;
    const [other] = await admin<{ id: string }[]>`select id from public.sales_documents where tenant_id = ${tenantA} and kind = 'invoice' and id <> ${row.invoice_id} limit 1`;
    expect(await codeOf(as.owner, sql`update public.counter_sales set buyer_name = 'Someone else' where id = ${row.id}`)).toBe("42501");
    expect(await codeOf(as.owner, sql`update public.counter_sales set invoice_id = ${other.id} where id = ${row.id}`)).toBe("SE123");
    expect(await codeOf(as.owner, sql`delete from public.counter_sales where id = ${row.id}`)).toBe("42501");
  });

  it("sells to the walk-in customer only at the counter, and never on credit", async () => {
    const customer = (await walkIn())!;
    // Not offered where a customer is chosen.
    expect((await searchCustomers(as.owner, "walk")).map((c) => c.label)).toEqual(["Walk-in customer"]);
    expect((await findCustomers(as.accountant, "walk")).map((c) => c.name)).toEqual(["Walk-in customer"]);
    // Refused by the app when chosen anyway.
    await expect(saveSalesDraft(as.owner, null, { kind: "order", date: DAY, customerId: customer, warehouseId: mainWarehouse, lines: [line("1")], shares: [] })).rejects.toThrow("Walk-in buyers are sold to at the counter");
    await expect(saveReceiptDraft(as.accountant, null, { date: DAY, customerId: customer, method: "cash", accountId: cash, amount: "500" })).rejects.toThrow("Walk-in buyers are sold to at the counter");
    // And by the database, past the app: an order that is not a counter sale's is not submitted...
    const refused = await refusedWith(as.owner, async (tx) => {
      const draft = await saveSalesDraftIn(tx, as.owner, null, {
        kind: "order",
        date: DAY,
        validUntil: null,
        customerId: customer,
        warehouseId: mainWarehouse,
        customerReference: null,
        notes: null,
        furtherTaxExcluded: false,
        lines: [{ itemId: helmet, description: null, unitId: null, quantity: new Decimal(1), unitPrice: null, discountPercent: null }],
        shares: [],
      });
      await submitIn(tx, as.owner, draft.id, undefined, {});
    });
    expect(refused).toBe("SE122");
    // ...a quotation is not written at all, and money from it is not taken but at the counter.
    expect(
      await codeOf(as.owner, sql`insert into public.sales_documents (tenant_id, kind, document_date, customer_id, warehouse_id, branch_id, currency, created_by, updated_by) values (${tenantA}, 'quotation', ${DAY}, ${customer}, ${mainWarehouse}, ${mainBranch}, 'PKR', ${userIds.owner}, ${userIds.owner})`),
    ).toBe("SE122");
    expect(await codeOf(as.accountant, sql`insert into public.receipts (tenant_id, receipt_date, customer_id, method, amount, cheque_number, cheque_bank, cheque_date, created_by, updated_by) values (${tenantA}, ${DAY}, ${customer}, 'cheque', 500, '1', 'HBL', ${DAY}, ${userIds.accountant}, ${userIds.accountant})`)).toBe("SE122");
    const stray = await admin<{ id: string }[]>`select gen_random_uuid() as id`;
    expect(
      await codeOf(
        as.accountant,
        sql`with r as (insert into public.receipts (id, tenant_id, receipt_date, customer_id, method, account_id, amount, created_by, updated_by) values (${stray[0].id}, ${tenantA}, ${DAY}, ${customer}, 'cash', ${cash}, 500, ${userIds.accountant}, ${userIds.accountant}) returning id) select app.post_receipt((select id from r))`,
      ),
    ).toBe("SE122");
  });

  it("never takes a counter sale's money back by cancelling its receipt", async () => {
    const [receipt] = await admin<{ id: string }[]>`select receipt_id as id from public.counter_sales where tenant_id = ${tenantA} order by created_at limit 1`;
    await expect(cancelReceipt(as.accountant, receipt.id, { date: DAY, reason: "Wrong account" })).rejects.toThrow("Money from a walk-in buyer is a counter sale's own receipt");
    // Nor is a second invoice made from a counter sale's order.
    const [first] = await admin<{ order_id: string; customer_id: string }[]>`
      select c.order_id, o.customer_id from public.counter_sales c join public.sales_documents o on o.id = c.order_id where c.tenant_id = ${tenantA} order by c.created_at limit 1`;
    expect(
      await codeOf(
        as.owner,
        sql`insert into public.sales_documents (tenant_id, kind, document_date, customer_id, warehouse_id, branch_id, currency, source_document_id, created_by, updated_by)
            values (${tenantA}, 'invoice', ${DAY}, ${first.customer_id}, ${mainWarehouse}, ${mainBranch}, 'PKR', ${first.order_id}, ${userIds.owner}, ${userIds.owner})`,
      ),
    ).toBe("SE122");
  });

  it("keeps the walk-in customer what it is: never archived, given credit, or given a tax identity", async () => {
    const customer = (await walkIn())!;
    for (const change of [sql`archived_at = now(), archived_by = ${userIds.owner}`, sql`credit_limit = 50000`, sql`credit_days = 30`, sql`cnic = '4210112345671'`]) {
      expect(await codeOf(as.owner, sql`update public.customers set ${change} where id = ${customer}`)).toBe("SE124");
    }
    expect(await codeOf(as.owner, sql`update public.customers set customer_class = 'Counter' where id = ${customer}`)).toBeUndefined();
  });

  it("names the buyer on a return, as the invoice did", async () => {
    const made = await postCounterSale(as.owner, sale({ buyerName: "Kamran Ali", lines: [line("3")] }));
    const { id } = await startCreditNote(as.owner, made.invoiceId);
    const [sold] = await admin<{ id: string }[]>`select id from public.sales_lines where document_id = ${made.invoiceId}`;
    await saveCreditNoteDraft(as.owner, id, { date: DAY, notes: "Wrong size", lines: [{ sourceLineId: sold.id, quantity: "1", damaged: "" }] });
    await postCreditNote(as.owner, id);
    expect((await getSalesDocument(as.owner, id))!.customerName).toBe("Kamran Ali");
    // What comes back from a paid sale is owed to the walk-in customer until it is refunded (Step 34).
    expect(await balance("customer_advances", (await walkIn())!)).toBe("-1000.00");
  });

  it("acceptance: an advance set against an invoice clears both", async () => {
    // The dealer pays 5,000 before anything is invoiced: all of it is an advance.
    const receipt = await saveReceiptDraft(as.accountant, null, { date: DAY, customerId: dealer, method: "cash", accountId: cash, amount: "5000" });
    await postReceipt(as.accountant, receipt.id);
    expect(await balance("customer_advances", dealer)).toBe("-5000.00");
    // Then three helmets are invoiced at 1,000.
    const order = await saveSalesDraft(as.owner, null, { kind: "order", date: DAY, customerId: dealer, warehouseId: mainWarehouse, lines: [line("3")], shares: [] });
    await submitSalesDocument(as.owner, order.id);
    const { id: invoice } = await startInvoice(as.owner, order.id);
    const draft = (await getSalesDocument(as.owner, invoice))!;
    await saveInvoiceDraft(as.owner, invoice, { date: DAY, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
    await postInvoice(as.owner, invoice);
    expect(await balance("ar", dealer)).toBe("3000.00");
    // 3,000 of the advance is set against the invoice: the invoice is paid, and 2,000 of the advance is left.
    await applyAdvance(as.accountant, receipt.id, { date: DAY, allocations: [{ kind: "invoice", id: invoice, amount: "3000" }] });
    expect(await balance("ar", dealer)).toBe("0.00");
    expect(await balance("customer_advances", dealer)).toBe("-2000.00");
    expect(await listOpenItems(as.accountant, dealer)).toEqual([]);
    // Every journal in the company balances.
    const [unbalanced] = await admin<{ n: number }[]>`
      select count(*)::int as n from (select j.id from public.journals j join public.journal_lines l on l.journal_id = j.id where j.tenant_id = ${tenantA} group by j.id having sum(l.debit) <> sum(l.credit)) x`;
    expect(unbalanced.n).toBe(0);
  });

  it("holds the order a counter sale is made with, so one changed meanwhile is read as it ends up", async () => {
    // A draft order to the walk-in customer, written past the app.
    const order = await withTenant(as.owner.userId, tenantA, async (tx) => {
      const [walk] = await tx.execute<{ id: string }>(sql`select app.walk_in_customer() as id`);
      return saveSalesDraftIn(tx, as.owner, null, {
        kind: "order",
        date: DAY,
        validUntil: null,
        customerId: walk.id,
        warehouseId: mainWarehouse,
        customerReference: null,
        notes: null,
        furtherTaxExcluded: false,
        lines: [{ itemId: helmet, description: null, unitId: null, quantity: new Decimal(1), unitPrice: null, discountPercent: null }],
        shares: [],
      });
    });
    // The owner turns it into the dealer's order and has not committed yet; an accountant, in a
    // session of their own, makes a counter sale with it meanwhile.
    const changer = await appSession(userIds.owner);
    const seller = await appSession(userIds.accountant);
    try {
      await changer.tx`update public.sales_documents set customer_id = ${dealer} where id = ${order.id}`;
      const sale = seller.tx`insert into public.counter_sales (tenant_id, order_id, buyer_name, client_key, created_by)
        values (${tenantA}, ${order.id}, 'Kamran Ali', gen_random_uuid(), ${userIds.accountant})`.then(
        () => "written",
        (error: unknown) => (error as { code?: string }).code ?? "unknown",
      );
      // It waits for the change rather than reading the order as it was.
      expect(await Promise.race([sale, sleep(500).then(() => "waiting")])).toBe("waiting");
      await changer.tx`commit`;
      // The order is the dealer's now: no counter sale is made with it.
      expect(await sale).toBe("SE122");
      await seller.tx`rollback`;
    } finally {
      await changer.end();
      await seller.end();
    }
    const [made] = await admin<{ n: number }[]>`select count(*)::int as n from public.counter_sales where order_id = ${order.id}`;
    expect(made.n).toBe(0);
  });
});
