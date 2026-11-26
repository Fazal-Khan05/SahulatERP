import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear, setPeriodLocked } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postInvoice } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { makeInvoiceNow } from "./commands";

// One-step "New invoice" against a real database, through the app's own path: the order, its
// delivery and its invoice made at once by the commands the Sales screens use; the credit limit
// and the stock rule stopping it part-way as they stop the two-step way. Skipped when the
// database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-direct-invoice-test";
const tenantA = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const mainBranch = randomUUID();
const mainWarehouse = randomUUID();
const ctx = (userId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@direct.test`, tenantId: tenantA, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const OPENED = "2026-10-01";
const DAY = "2026-10-20";

let admin: AdminSql;
let helmet: string;
let dealer: string;
let cityBikes: string;

const line = (quantity: string, unitPrice = "") => ({ itemId: helmet, quantity, unitId: "", unitPrice, discountPercent: "" });
const invoice = (over: Record<string, unknown> = {}) => ({ date: DAY, customerId: dealer, warehouseId: mainWarehouse, customerReference: "PO-77", notes: "", furtherTaxExcluded: "", lines: [line("2")], shares: [{ userId: userIds.sales_manager, percent: "100" }], ...over });
const onHand = async () => (await admin<{ q: string }[]>`select trim_scale(quantity)::text as q from public.stock_balances where tenant_id = ${tenantA} and item_id = ${helmet} and warehouse_id = ${mainWarehouse}`)[0].q;
const counts = async () => (await admin<{ v: string }[]>`select string_agg(kind || ' ' || status, ', ' order by kind, status) as v from public.sales_documents where tenant_id = ${tenantA}`)[0].v ?? "";
const receivable = async (customerId: string) =>
  (
    await admin<{ v: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantA} and a.control_type = 'ar' and l.customer_id = ${customerId}`
  )[0].v;

describe.skipIf(!hasDb)("one-step new invoice", () => {
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
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    dealer = (await createParty(as.owner, "customer", { name: "Karachi Dealer", code: "C-001", creditDays: "30", creditLimit: "50000" })).id;
    cityBikes = (await createParty(as.owner, "customer", { name: "City Bikes", code: "C-002" })).id;
    const stock = await saveAdjustmentDraft(as.owner, "opening", null, { date: OPENED, warehouseId: mainWarehouse, lines: [{ itemCode: "HL-1", direction: "in", quantity: "100", unitCost: "600" }] });
    await postAdjustment(as.owner, stock.id);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("makes the order, delivers it and posts its invoice at once, at the price lists' price", async () => {
    const made = await makeInvoiceNow(as.sales_manager, invoice());
    expect(made).toMatchObject({ status: "posted", invoiceNumber: "SI-2627-00001", orderNumber: "SO-2627-00001" });
    if (made.status !== "posted") return;
    const posted = (await getSalesDocument(as.owner, made.invoiceId))!;
    expect([posted.kind, posted.status, posted.date, posted.dueDate, posted.customerName, posted.totals.total.toFixed(2)]).toEqual(["invoice", "submitted", DAY, "2026-11-19", "Karachi Dealer", "2000.00"]);
    expect(posted.madeFrom.map((d) => [d.kind, d.number, d.status])).toEqual([["order", "SO-2627-00001", "submitted"]]);
    expect(posted.shares.map((s) => [s.userId, s.percent.toFixed(0)])).toEqual([[userIds.sales_manager, "100"]]);
    expect(await onHand()).toBe("98");
    expect(await receivable(dealer)).toBe("2000.00");
    const audit = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and action = 'direct_invoice.post' and entity_id = ${made.invoiceId}`;
    expect(audit).toHaveLength(1);
  });

  it("leaves a sale over the credit limit as an order waiting for the owner, with nothing delivered", async () => {
    const before = await onHand();
    const held = await makeInvoiceNow(as.sales_manager, invoice({ lines: [line("60")] }));
    expect(held.status).toBe("on_hold");
    if (held.status !== "on_hold") return;
    expect(held.message).toMatch(/credit limit/i);
    expect(held.message).toMatch(/owner's approval/);
    const order = (await getSalesDocument(as.owner, held.orderId))!;
    expect([order.kind, order.status, order.number]).toEqual(["order", "on_hold", null]);
    expect(order.madeInto).toEqual([]);
    expect(await onHand()).toBe(before);
  });

  it("asks the owner for a reason over the limit, keeping nothing until it is given", async () => {
    const before = await counts();
    await expect(makeInvoiceNow(as.owner, invoice({ lines: [line("55")] }))).rejects.toThrow(/As the owner you can approve it/);
    expect(await counts()).toBe(before);
    const made = await makeInvoiceNow(as.owner, invoice({ lines: [line("55")], reason: "Cheque due on Monday" }));
    expect(made).toMatchObject({ status: "posted", invoiceNumber: "SI-2627-00002", orderNumber: "SO-2627-00002" });
    expect(await onHand()).toBe("43");
  });

  it("short of stock, keeps the order and a draft invoice to post once the goods are in", async () => {
    const short = await makeInvoiceNow(as.sales_manager, invoice({ customerId: cityBikes, lines: [line("50")] }));
    expect(short.status).toBe("short");
    if (short.status !== "short") return;
    expect(short.message).toContain("Not enough HL-1 in stock at Main store: 43 on hand, 50 needed.");
    const draft = (await getSalesDocument(as.owner, short.invoiceId))!;
    expect([draft.kind, draft.status, draft.number]).toEqual(["invoice", "draft", null]);
    expect(await onHand()).toBe("43");
    const more = await saveAdjustmentDraft(as.owner, "opening", null, { date: OPENED, warehouseId: mainWarehouse, lines: [{ itemCode: "HL-1", direction: "in", quantity: "10", unitCost: "600" }] });
    await postAdjustment(as.owner, more.id);
    expect((await postInvoice(as.owner, short.invoiceId)).number).toBe("SI-2627-00003");
    expect(await onHand()).toBe("3");
  });

  it("is refused to a role that does not write sales, on a day not come, in a locked period, and with no lines", async () => {
    await expect(makeInvoiceNow(as.auditor, invoice())).rejects.toThrow("Your role cannot write sales documents.");
    await expect(makeInvoiceNow(as.owner, invoice({ date: "2099-01-01" }))).rejects.toThrow("never on a day that has not come");
    await expect(makeInvoiceNow(as.owner, invoice({ lines: [] }))).rejects.toThrow("Enter at least one line");
    await expect(makeInvoiceNow(as.owner, invoice({ customerId: "" }))).rejects.toThrow(/customer/i);
    const before = await counts();
    const [october] = await admin<{ id: string }[]>`select id from public.fiscal_periods where tenant_id = ${tenantA} and ${DAY}::date between starts_on and ends_on`;
    await setPeriodLocked(as.owner, october.id, true);
    await expect(makeInvoiceNow(as.owner, invoice({ customerId: cityBikes }))).rejects.toThrow(/locked|closed/i);
    await setPeriodLocked(as.owner, october.id, false);
    expect(await counts()).toBe(before);
  });
});
