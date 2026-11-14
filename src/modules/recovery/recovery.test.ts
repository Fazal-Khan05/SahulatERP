import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { todayIso } from "@/lib/format";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { postInvoice, saveInvoiceDraft, saveSalesDraft, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addFollowUp, addPromise } from "./commands";
import { getCustomerRecovery, getCustomerStatement, listCustomerAgeing, listFollowUpsDue, listPromises, listRecoveryMarks } from "./queries";
import { ageingTable, overdueCustomers } from "./rules";

// Step 33 against a real database, through the app's own path: invoices and receipts posted by
// the app's own commands, then the aged receivables, the overdue list (which must match it),
// customer statements read from the books, promises to pay, follow-ups, and what the database
// refuses to anyone writing SQL by hand. Skipped without the database URLs.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-recovery-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager", "recovery_officer"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const northManager = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const northBranch = randomUUID();
const mainStore = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@recovery.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const north = ctx(northManager, tenantA, "sales_manager", [northBranch]);
const other = ctx(ownerB, tenantB, "owner");
const ASAT = "2026-11-15";
const TODAY = todayIso(new Date());
const plusDays = (days: number) => new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1, +TODAY.slice(8, 10) + days)).toISOString().slice(0, 10);

let admin: AdminSql;
let cash: string;
let helmet: string;
let khan: string;
let rider: string;
const invoices: Record<string, string> = {};

async function invoice(customerId: string, date: string, quantity: string): Promise<string> {
  const { id: order } = await saveSalesDraft(as.owner, null, { kind: "order", date, customerId, warehouseId: mainStore, lines: [{ itemId: helmet, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" }], shares: [] });
  await submitSalesDocument(as.owner, order);
  const { id } = await startInvoice(as.owner, order);
  const draft = (await getSalesDocument(as.owner, id))!;
  await saveInvoiceDraft(as.owner, id, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  await postInvoice(as.owner, id);
  return id;
}
async function receive(customerId: string, date: string, amount: string, pays: [string, string][]): Promise<void> {
  const { id } = await saveReceiptDraft(as.recovery_officer, null, { date, customerId, method: "cash", accountId: cash, amount, allocations: pays.map(([invoiceId, part]) => ({ kind: "invoice", id: invoiceId, amount: part })) });
  await postReceipt(as.recovery_officer, id);
}
async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const money = (value: Decimal) => value.toFixed(2);

describe.skipIf(!hasDb)("recovery", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${northBranch}, ${tenantA}, 'North', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${mainStore}, ${tenantA}, ${mainBranch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: northManager, email: north.email, role: "sales_manager", branch_ids: [northBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: other.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenantA}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    cash = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and code = '1111'`)[0].id;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    helmet = (await createItem(as.owner, { code: "HL-1", name: "Helmet", unit: piece, defaultPrice: "1000" })).id;
    khan = (await createParty(as.owner, "customer", { name: "Khan Autos", code: "C-001", creditDays: "30" })).id;
    rider = (await createParty(as.owner, "customer", { name: "Walk-in Rider", code: "C-002" })).id;
    const { id: opening } = await saveAdjustmentDraft(as.owner, "opening", null, { date: "2026-08-01", warehouseId: mainStore, lines: [{ itemCode: "HL-1", direction: "in", quantity: "100", unitCost: "600" }] });
    await postAdjustment(as.owner, opening);

    // Khan Autos (30 days' credit): 10,000 invoiced on 10 August, due 9 September; 5,000 on 20 October, due 19 November.
    invoices.first = await invoice(khan, "2026-08-10", "10");
    invoices.second = await invoice(khan, "2026-10-20", "5");
    // Walk-in Rider (no credit): 3,000 on 1 September, due the same day.
    invoices.third = await invoice(rider, "2026-09-01", "3");
    // 20 September: Khan Autos pays 4,000 of the first invoice.
    await receive(khan, "2026-09-20", "4000", [[invoices.first, "4000"]]);
  }, 300_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("ages what customers owe by days past due, and the overdue list matches the ageing report", async () => {
    const aged = await listCustomerAgeing(as.recovery_officer, ASAT);
    const table = ageingTable(aged, ASAT);
    const cells = (name: string) => table.rows.find((row) => row.cells[1] === name)!.cells.slice(2).map((cell) => (cell === null ? "" : money(cell as Decimal)));
    // Khan: 6,000 left of the first invoice, 67 days past due; 5,000 not due yet. Rider: 3,000, 75 days past due.
    expect(cells("Khan Autos")).toEqual(["5000.00", "", "", "6000.00", "", "11000.00"]);
    expect(cells("Walk-in Rider")).toEqual(["", "", "", "3000.00", "", "3000.00"]);
    expect(cells("Total")).toEqual(["5000.00", "0.00", "0.00", "9000.00", "0.00", "14000.00"]);

    const overdue = overdueCustomers(aged);
    expect(overdue.map((row) => `${row.name} ${money(row.overdue)} ${row.oldestDays}`)).toEqual(["Khan Autos 6000.00 67", "Walk-in Rider 3000.00 75"]);
    // The acceptance test: the overdue list matches the ageing report, customer by customer and in total.
    for (const row of overdue) expect(money(row.overdue)).toBe(money((table.rows.find((r) => r.cells[1] === row.name)!.cells.slice(3, 7) as (Decimal | null)[]).reduce<Decimal>((t, c) => t.plus(c ?? 0), new Decimal(0))));
    const bands = (table.rows.at(-1)!.cells.slice(3, 7) as Decimal[]).reduce((t, c) => t.plus(c), new Decimal(0));
    expect(money(overdue.reduce((t, row) => t.plus(row.overdue), new Decimal(0)))).toBe(money(bands));
    // And it agrees with the receivables account in the books.
    const [books] = await admin<{ owed: string }[]>`select sum(l.debit - l.credit)::text as owed from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantA} and a.control_type = 'ar'`;
    expect(money(new Decimal(books.owed))).toBe("14000.00");

    // The same for every role that works recovery; a member limited to another branch sees none of it.
    for (const who of [as.owner, as.accountant, as.auditor, as.sales_manager]) expect((await listCustomerAgeing(who, ASAT)).length, who.role).toBe(2);
    expect(await listCustomerAgeing(north, ASAT)).toEqual([]);
    for (const who of [as.salesperson, as.warehouse_manager]) await expect(listCustomerAgeing(who, ASAT), who.role).rejects.toThrow("Your role does not include recovery.");
  });

  it("makes the customer statement from the books: opening balance, each line with the balance after it", async () => {
    const statement = (await getCustomerStatement(as.recovery_officer, khan, { from: "2026-09-01", to: ASAT }))!;
    expect(statement.customer).toMatchObject({ name: "Khan Autos", code: "C-001" });
    expect(money(statement.statement.opening)).toBe("10000.00");
    expect(statement.statement.rows.map((row) => `${row.date} ${row.what} ${row.number} ${money(row.debit)} ${money(row.credit)} ${money(row.balance)}`)).toEqual([
      "2026-09-20 Received RC-2627-00001 0.00 4000.00 6000.00",
      "2026-10-20 Invoice SI-2627-00002 5000.00 0.00 11000.00",
    ]);
    expect(money(statement.statement.closing)).toBe("11000.00");
    expect(statement.open.map((item) => `${item.number} ${money(item.outstanding)}`)).toEqual(["SI-2627-00001 6000.00", "SI-2627-00002 5000.00"]);
    // The sales manager, who does not read journals or receipts, gets the same statement; another branch's member gets nothing of Main's.
    expect(money((await getCustomerStatement(as.sales_manager, khan, { from: "2026-09-01", to: ASAT }))!.statement.closing)).toBe("11000.00");
    const northView = (await getCustomerStatement(north, khan, { from: "2026-01-01", to: ASAT }))!;
    expect(northView.statement.rows).toEqual([]);
    expect(money(northView.statement.closing)).toBe("0.00");
    await expect(getCustomerStatement(as.salesperson, khan, { from: "2026-09-01", to: ASAT })).rejects.toThrow("Your role does not include recovery.");
    expect(await getCustomerStatement(other, khan, { from: "2026-09-01", to: ASAT })).toBeNull();
  });

  it("shows money paid ahead on the statement as one receipt, and the customer in credit", async () => {
    // The rider pays 3,500 today: 3,000 settles the invoice and 500 is kept as an advance.
    await receive(rider, TODAY, "3500", [[invoices.third, "3000"]]);
    const statement = (await getCustomerStatement(as.accountant, rider, { from: "2026-09-01", to: TODAY }))!;
    expect(statement.statement.rows.map((row) => `${row.what} ${money(row.debit)} ${money(row.credit)} ${money(row.balance)}`)).toEqual(["Invoice 3000.00 0.00 3000.00", "Received 0.00 3500.00 -500.00"]);
    expect(statement.open).toEqual([]);
    // Nothing is owed any more, so the rider leaves the overdue list.
    expect(overdueCustomers(await listCustomerAgeing(as.owner, ASAT)).map((row) => row.name)).toEqual(["Khan Autos"]);
  });

  it("keeps promises to pay, and says which were kept and which broken", async () => {
    await expect(addPromise(as.auditor, khan, { amount: "2000", promisedOn: plusDays(5) }, TODAY)).rejects.toThrow("Your role cannot record follow-ups or promises.");
    await expect(addPromise(as.recovery_officer, khan, { amount: "2000", promisedOn: plusDays(-1) }, TODAY)).rejects.toThrow("A promise is for today or a day to come.");
    await addPromise(as.recovery_officer, khan, { amount: "2000", promisedOn: plusDays(5), note: "Cheque on Friday" }, TODAY);
    await addPromise(as.sales_manager, khan, { amount: "1000", promisedOn: TODAY }, TODAY);
    // Nothing has come since: the one due today is waiting until today is over.
    expect((await listPromises(as.auditor, TODAY)).map((p) => `${money(p.amount)} ${p.state}`)).toEqual(["2000.00 waiting", "1000.00 waiting"]);
    expect((await listPromises(as.owner, plusDays(1))).map((p) => `${money(p.amount)} ${p.state}`)).toEqual(["2000.00 waiting", "1000.00 broken"]);

    // 1,500 comes in today: the 1,000 promise is kept; the 2,000 one, if nothing more comes, is broken after its day, with what did arrive.
    await receive(khan, TODAY, "1500", [[invoices.first, "1500"]]);
    const later = await listPromises(as.recovery_officer, plusDays(6));
    expect(later.map((p) => `${money(p.amount)} ${p.state} ${money(p.received)}`)).toEqual(["2000.00 broken 1500.00", "1000.00 kept 1500.00"]);
    expect(later[0]).toMatchObject({ madeOn: TODAY, note: "Cheque on Friday", by: "you" });
    expect((await listRecoveryMarks(as.owner, plusDays(6))).get(khan)?.brokenPromises).toBe(1);
  });

  it("keeps follow-ups, and lists those due", async () => {
    await expect(addFollowUp(as.salesperson, khan, { note: "x" }, TODAY)).rejects.toThrow("Your role cannot record follow-ups or promises.");
    await addFollowUp(as.recovery_officer, khan, { note: "Called; will send the cheque", nextOn: TODAY }, TODAY);
    await addFollowUp(as.recovery_officer, rider, { note: "Thanked for paying", nextOn: plusDays(3) }, TODAY);
    expect((await listFollowUpsDue(as.sales_manager, TODAY)).map((f) => f.customerName)).toEqual(["Khan Autos"]);
    expect((await listFollowUpsDue(as.owner, plusDays(3))).map((f) => f.customerName)).toEqual(["Khan Autos", "Walk-in Rider"]);
    // A newer follow-up with no next step takes the customer off the list.
    await addFollowUp(as.accountant, khan, { note: "Paid in part; nothing more agreed" }, TODAY);
    expect((await listFollowUpsDue(as.owner, TODAY)).map((f) => f.customerName)).toEqual([]);
    const page = (await getCustomerRecovery(as.recovery_officer, khan, ASAT))!;
    expect(page.followUps.map((f) => `${f.note} | ${f.by}`)).toEqual(["Paid in part; nothing more agreed | another member", "Called; will send the cheque | you"]);
    expect(page.items.map((item) => `${item.number} ${money(item.outstanding)}`)).toEqual(["SI-2627-00001 4500.00", "SI-2627-00002 5000.00"]);
    expect(page.promises).toHaveLength(2);
    const audits = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and action in ('customer.promise', 'customer.follow_up') order by at`;
    expect(audits.map((a) => a.action)).toEqual(["customer.promise", "customer.promise", "customer.follow_up", "customer.follow_up", "customer.follow_up"]);
  });

  it("holds the logs and the two functions to their rules for SQL written by hand as the app's role", async () => {
    const officer = as.recovery_officer;
    const me = userIds.recovery_officer;
    // A follow-up or a promise is written as oneself, now, by a role that works recovery.
    expect(await codeOf(officer, sql`insert into public.customer_follow_ups (tenant_id, customer_id, note, created_by) values (${tenantA}, ${khan}, 'x', ${userIds.owner})`)).toBe("42501");
    expect(await codeOf(officer, sql`insert into public.customer_follow_ups (tenant_id, customer_id, note, created_by, created_at) values (${tenantA}, ${khan}, 'x', ${me}, '2020-01-01')`)).toBe("42501");
    expect(await codeOf(officer, sql`insert into public.customer_follow_ups (tenant_id, customer_id, note, next_on, created_by) values (${tenantA}, ${khan}, 'x', '2020-01-01', ${me})`)).toBe("42501");
    expect(await codeOf(as.auditor, sql`insert into public.customer_follow_ups (tenant_id, customer_id, note, created_by) values (${tenantA}, ${khan}, 'x', ${userIds.auditor})`)).toBe("42501");
    // A promise cannot be dated back to take in money that came before it.
    expect(await codeOf(officer, sql`insert into public.payment_promises (tenant_id, customer_id, amount, made_on, promised_on, created_by) values (${tenantA}, ${khan}, 100, ${plusDays(-30)}, ${TODAY}, ${me})`)).toBe("42501");
    expect(await codeOf(officer, sql`insert into public.payment_promises (tenant_id, customer_id, amount, made_on, promised_on, created_by) values (${tenantA}, ${khan}, 0, ${TODAY}, ${TODAY}, ${me})`)).toBe("23514");
    expect(await codeOf(officer, sql`insert into public.payment_promises (tenant_id, customer_id, amount, made_on, promised_on, created_by) values (${tenantA}, ${khan}, 'NaN', ${TODAY}, ${TODAY}, ${me})`)).toBe("23514");
    // "infinity" would make a promise that never breaks and a follow-up never due.
    expect(await codeOf(officer, sql`insert into public.payment_promises (tenant_id, customer_id, amount, made_on, promised_on, created_by) select ${tenantA}, ${khan}, 100, (statement_timestamp() at time zone 'Asia/Karachi')::date, 'infinity', ${me}`)).toBe("23514");
    expect(await codeOf(officer, sql`insert into public.customer_follow_ups (tenant_id, customer_id, note, next_on, created_by) values (${tenantA}, ${khan}, 'x', 'infinity', ${me})`)).toBe("23514");
    // Nothing is changed or removed, and another company sees nothing.
    expect(await codeOf(as.owner, sql`update public.customer_follow_ups set note = 'changed'`)).toBe("42501");
    expect(await codeOf(as.owner, sql`delete from public.payment_promises`)).toBe("42501");
    const count = async (who: TenantContext) => (await withTenant(who.userId, who.tenantId, (tx) => tx.execute<{ n: number }>(sql`select (select count(*) from public.customer_follow_ups)::int + (select count(*) from public.payment_promises)::int as n`)))[0].n;
    expect(await count(other)).toBe(0);
    expect(await count(as.salesperson)).toBe(0);
    expect(await count(as.auditor)).toBeGreaterThan(0);
    // The two functions answer only those who work recovery, and only about their own company.
    for (const who of [as.salesperson, as.warehouse_manager]) {
      expect(await codeOf(who, sql`select app.customer_received(${khan}::uuid, '2026-01-01'::date, '2026-12-31'::date)`), who.role).toBe("42501");
      expect(await codeOf(who, sql`select * from app.customer_statement(${khan}::uuid, '2026-01-01'::date, '2026-12-31'::date)`), who.role).toBe("42501");
    }
    const received = await withTenant(other.userId, other.tenantId, (tx) => tx.execute<{ r: string }>(sql`select app.customer_received(${khan}::uuid, '2026-01-01'::date, '2026-12-31'::date)::text as r`));
    expect(received[0].r).toBe("0");
    const lines = await withTenant(other.userId, other.tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from app.customer_statement(${khan}::uuid, '2026-01-01'::date, '2026-12-31'::date) where source_type <> 'opening'`));
    expect(lines[0].n).toBe(0);
    expect(await codeOf(officer, sql`select * from app.customer_statement(${khan}::uuid, '2026-12-31'::date, '2026-01-01'::date)`)).toBe("22023");
  });
});
