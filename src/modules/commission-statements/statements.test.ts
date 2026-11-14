import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { savePlan, setManager } from "@/modules/commissions/commands";
import { postCreditNote, saveCreditNoteDraft, startCreditNote } from "@/modules/credit-notes/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { bounceCheque, clearCheque, depositCheque, postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { postInvoice, saveInvoiceDraft, saveSalesDraft, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { seedStock } from "../../../tests/support/stock";
import { getCommissionStatement, listStatements } from "./queries";
import { owedToThem } from "./rules";

// Commission statements against a real database, through the app's own path (app_runtime,
// withTenant): a statement is the person's commission movements for the period and nothing
// else (the acceptance test), and who may read whose. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-commission-statements-test";
const tenant = randomUUID();
const other = randomUUID();
const roles = ["owner", "accountant", "auditor"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
// Imran manages Ali, who manages Sana. Zara is on nobody's team.
const people = Object.fromEntries(["imran", "ali", "sana", "zara"].map((key) => [key, randomUUID()])) as Record<string, string>;
const cityAccountant = randomUUID();
const otherOwner = randomUUID();
const branch = randomUUID();
const cityBranch = randomUUID();
const warehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@statements.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenant, role)])) as Record<(typeof roles)[number], TenantContext>;
const imran = ctx(people.imran, tenant, "sales_manager");
const seller = (key: string) => ctx(people[key], tenant, "salesperson");
const scoped = ctx(cityAccountant, tenant, "accountant", [cityBranch]);
const stranger = ctx(otherOwner, other, "owner");

let admin: AdminSql;
let lamp: string;
let retailer: string;
let cash: string;
let bank: string;
let chequeNo = 771000;
const numbers: Record<string, string> = {};

/** An invoice of so many lamps at 100, all Ali's, ready to post. */
async function sell(date: string, quantity: string): Promise<string> {
  const order = await saveSalesDraft(as.owner, null, {
    kind: "order",
    date,
    customerId: retailer,
    warehouseId: warehouse,
    lines: [{ itemId: lamp, quantity, unitId: "", unitPrice: "", discountPercent: "", description: "" }],
    shares: [{ userId: people.ali, percent: "100" }],
  });
  await submitSalesDocument(as.owner, order.id, undefined, { reason: "Test order" }).catch(async () => submitSalesDocument(as.owner, order.id));
  const { id } = await startInvoice(as.owner, order.id);
  const draft = (await getSalesDocument(as.owner, id))!;
  await saveInvoiceDraft(as.owner, id, { date, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
  return id;
}
async function post(id: string): Promise<string> {
  return (await postInvoice(as.owner, id)).number;
}
async function cashIn(date: string, invoiceId: string, amount: string): Promise<string> {
  const draft = await saveReceiptDraft(as.accountant, null, { date, customerId: retailer, method: "cash", accountId: cash, amount, allocations: [{ kind: "invoice", id: invoiceId, amount }] });
  return (await postReceipt(as.accountant, draft.id)).number;
}
async function chequeIn(date: string, invoiceId: string, amount: string): Promise<{ id: string; number: string }> {
  chequeNo += 1;
  const draft = await saveReceiptDraft(as.accountant, null, { date, customerId: retailer, method: "cheque", amount, chequeNumber: String(chequeNo), chequeBank: "Meezan Bank", chequeDate: date, allocations: [{ kind: "invoice", id: invoiceId, amount }] });
  return { id: draft.id, number: (await postReceipt(as.accountant, draft.id)).number };
}
/** Approves everything released and unpaid of one person, and pays it from cash, as the owner. */
async function approveAndPay(key: string, date: string): Promise<string> {
  const ids = (await admin<{ id: string }[]>`select id from public.commission_accruals where tenant_id = ${tenant} and user_id = ${people[key]} and released > paid and approved_at is null`).map((row) => row.id);
  return withTenant(as.owner.userId, tenant, async (tx) => {
    await tx.execute(sql`select app.approve_commission(${`{${ids.join(",")}}`}::uuid[])`);
    const [paid] = await tx.execute<{ number: string }>(sql`select number from app.pay_commission(${people[key]}::uuid, ${date}::date, ${cash}::uuid, null)`);
    return paid.number;
  });
}
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
const plain = (amount: Decimal) => amount.toFixed(2);
const figures = (f: { earned: Decimal; released: Decimal; paid: Decimal }) => [f.earned, f.released, f.paid].map(plain);
const november = { from: "2026-11-01", to: "2026-11-30" };
const october = { from: "2026-10-01", to: "2026-10-31" };

describe.skipIf(!hasDb)("commission statements", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenant}, ${PREFIX}, ${userIds.owner}), (${other}, ${PREFIX + " other"}, ${otherOwner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenant}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenant}, 'City', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${warehouse}, ${tenant}, ${branch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenant, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenant, user_id: people.imran, email: "imran@statements.test", role: "sales_manager", branch_ids: null, created_by: userIds.owner },
      ...["ali", "sana", "zara"].map((key) => ({ tenant_id: tenant, user_id: people[key], email: `${key}@statements.test`, role: "salesperson", branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenant, user_id: cityAccountant, email: scoped.email, role: "accountant", branch_ids: [cityBranch], created_by: userIds.owner },
      { tenant_id: other, user_id: otherOwner, email: stranger.email, role: "owner", branch_ids: null, created_by: otherOwner },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${tenant}, false, 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const account = async (code: string) => (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenant} and code = ${code}`)[0].id;
    cash = await account("1111");
    bank = (await addAccount(as.owner, { parentId: await account("1120"), name: "HBL current account", code: "", kind: "account" })).id;
    lamp = (await createItem(as.owner, { code: "LT-1", name: "Lamp", unit: (await addUnit(as.owner, { code: "pc", name: "Piece" })).id, defaultPrice: "100" })).id;
    retailer = (await createParty(as.owner, "customer", { name: "Corner Shop", code: "C-001" })).id;
    await seedStock(admin, { tenantId: tenant, warehouseId: warehouse, userId: userIds.owner, itemId: lamp, quantity: "100000", value: "5000000" });

    // 2% for everyone; Imran earns 0.5% on what his team sells.
    const plan = (over: Record<string, unknown>) => ({ name: "Standard plan", kind: "flat", rate: "2", from: "2026-09-01", to: "", ...over });
    await savePlan(as.owner, null, plan({}));
    await savePlan(as.owner, null, plan({ name: "Area manager", userId: people.imran, teamRate: "0.5" }));
    await setManager(as.owner, people.ali, people.imran);
    await setManager(as.owner, people.sana, people.ali);

    // October: invoice A, half paid in cash, and Ali paid what that released.
    const a = await sell("2026-10-01", "100");
    numbers.a = await post(a);
    numbers.cashA = await cashIn("2026-10-02", a, "5000");
    numbers.cp1 = await approveAndPay("ali", "2026-10-03");
    // November: a cheque for the rest clears and Ali is paid; it then bounces, so he owes 100
    // back. Ten lamps come back. Invoice B is paid in full in cash, and the next payment takes
    // back what he owed.
    const cheque = await chequeIn("2026-11-02", a, "5000");
    numbers.cheque = cheque.number;
    await depositCheque(as.accountant, cheque.id, { accountId: bank, date: "2026-11-04" });
    await clearCheque(as.accountant, cheque.id, { date: "2026-11-04", bankCharges: "" });
    numbers.cp2 = await approveAndPay("ali", "2026-11-04");
    await bounceCheque(as.accountant, cheque.id, { date: "2026-11-05", reason: "Insufficient funds" });
    const { id: note } = await startCreditNote(as.accountant, a);
    const [line] = await admin<{ id: string }[]>`select id from public.sales_lines where document_id = ${a}`;
    await saveCreditNoteDraft(as.accountant, note, { date: "2026-11-06", lines: [{ sourceLineId: line.id, quantity: "10", damaged: "" }] });
    numbers.cn = (await postCreditNote(as.accountant, note)).number;
    const b = await sell("2026-11-07", "100");
    numbers.b = await post(b);
    numbers.cashB = await cashIn("2026-11-08", b, "10000");
    numbers.cp3 = await approveAndPay("ali", "2026-11-09");
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenant, other]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("is the movements for the period: each event once, in order, with what is owed after it", async () => {
    const data = (await getCommissionStatement(as.owner, people.ali, november))!;
    expect(data.person.name).toBe("ali@statements.test");
    expect(figures(data.statement.opening)).toEqual(["200.00", "100.00", "100.00"]);
    expect(data.statement.lines.map((l) => [l.date, l.what, l.number, plain(l.earned), plain(l.released), plain(l.paid), plain(l.balance)])).toEqual([
      ["2026-11-04", `Released: the customer paid (${numbers.cheque})`, numbers.a, "0.00", "100.00", "0.00", "100.00"],
      ["2026-11-04", "Commission paid", numbers.cp2, "0.00", "0.00", "100.00", "0.00"],
      ["2026-11-05", `Release taken back: the customer's payment was undone (${numbers.cheque})`, numbers.a, "0.00", "-100.00", "0.00", "-100.00"],
      ["2026-11-06", `Goods returned (${numbers.cn})`, numbers.a, "-20.00", "0.00", "0.00", "-100.00"],
      ["2026-11-07", "Earned on the sale", numbers.b, "200.00", "0.00", "0.00", "-100.00"],
      ["2026-11-08", `Released: the customer paid (${numbers.cashB})`, numbers.b, "0.00", "200.00", "0.00", "100.00"],
      ["2026-11-09", "Commission paid: 200.00 approved, less 100.00 owed back", numbers.cp3, "0.00", "0.00", "100.00", "0.00"],
    ]);
    expect(data.statement.lines[0].customerName).toBe("Corner Shop");

    // The period is exactly the movements dated in it, by type.
    const [moved] = await admin<{ earned: string; released: string; paid: string }[]>`
      select coalesce(sum(m.amount) filter (where m.type in ('accrued', 'entitlement_adjusted')), 0)::numeric(20,2)::text as earned,
             coalesce(sum(case m.type when 'released' then m.amount when 'release_reversed' then -m.amount end), 0)::numeric(20,2)::text as released,
             coalesce(sum(case m.type when 'paid' then m.amount when 'recovery_recorded' then -m.amount end), 0)::numeric(20,2)::text as paid
      from public.commission_movements m join public.commission_accruals a on a.id = m.accrual_id
      where a.tenant_id = ${tenant} and a.user_id = ${people.ali} and m.movement_date between '2026-11-01' and '2026-11-30'`;
    expect(figures(data.statement.period)).toEqual([moved.earned, moved.released, moved.paid]);
    expect(figures(data.statement.period)).toEqual(["180.00", "200.00", "200.00"]);

    // What came before plus the period is where the accruals stand now.
    const [now] = await admin<{ earned: string; released: string; paid: string }[]>`
      select sum(earned)::numeric(20,2)::text as earned, sum(released)::numeric(20,2)::text as released, sum(paid)::numeric(20,2)::text as paid
      from public.commission_accruals where tenant_id = ${tenant} and user_id = ${people.ali}`;
    expect(figures(data.statement.closing)).toEqual([now.earned, now.released, now.paid]);
  });

  it("carries one period's end into the next one's beginning", async () => {
    const before = (await getCommissionStatement(as.owner, people.ali, october))!;
    const after = (await getCommissionStatement(as.owner, people.ali, november))!;
    expect(figures(before.statement.closing)).toEqual(figures(after.statement.opening));
    expect(before.statement.lines.map((l) => [l.what, l.number])).toEqual([
      ["Earned on the sale", numbers.a],
      [`Released: the customer paid (${numbers.cashA})`, numbers.a],
      ["Commission paid", numbers.cp1],
    ]);
  });

  it("names the team member and the team rate on a manager's statement", async () => {
    const data = (await getCommissionStatement(imran, people.imran, november))!;
    expect(figures(data.statement.opening)).toEqual(["50.00", "25.00", "0.00"]);
    expect(data.statement.lines.map((l) => [l.what, l.number, l.teamMember, plain(l.earned), plain(l.released)])).toEqual([
      [`Released: the customer paid (${numbers.cheque})`, numbers.a, "ali@statements.test", "0.00", "25.00"],
      [`Release taken back: the customer's payment was undone (${numbers.cheque})`, numbers.a, "ali@statements.test", "0.00", "-25.00"],
      [`Goods returned (${numbers.cn})`, numbers.a, "ali@statements.test", "-5.00", "0.00"],
      ["Earned at the 0.5% team rate", numbers.b, "ali@statements.test", "50.00", "0.00"],
      [`Released: the customer paid (${numbers.cashB})`, numbers.b, "ali@statements.test", "0.00", "50.00"],
    ]);
  });

  it("adds up, across everyone, to the books", async () => {
    const { everyone, people: all } = await listStatements(as.owner, { from: "2026-07-01", to: "2026-11-30" });
    expect(everyone).toBe(true);
    expect(all.map((p) => p.name)).toEqual(["ali@statements.test", "imran@statements.test"]);
    const earned = all.reduce((sum, p) => sum.plus(p.closing.earned), new Decimal(0));
    const paid = all.reduce((sum, p) => sum.plus(p.closing.paid), new Decimal(0));
    const balance = async (control: string) =>
      new Decimal(
        (await admin<{ v: string }[]>`select coalesce(sum(l.debit - l.credit), 0)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenant} and a.control_type = ${control}`)[0].v,
      );
    expect(plain(await balance("commission_expense"))).toBe(plain(earned));
    expect(plain((await balance("commission_payable")).negated())).toBe(plain(earned.minus(paid)));
    const ali = all.find((p) => p.userId === people.ali)!;
    expect(figures(ali.period)).toEqual(["380.00", "300.00", "300.00"]);
    expect(plain(owedToThem(ali.closing))).toBe("0.00");
  });

  it("gives a salesperson their own and their team's, and nobody else's", async () => {
    const own = (await getCommissionStatement(seller("ali"), people.ali, november))!;
    // The receipt and credit note numbers are there, though a salesperson reads no receipts.
    expect(own.statement.lines[0].what).toBe(`Released: the customer paid (${numbers.cheque})`);
    expect(await getCommissionStatement(seller("ali"), people.sana, november)).not.toBeNull();
    expect(await getCommissionStatement(seller("ali"), people.zara, november)).toBeNull();
    expect(await getCommissionStatement(seller("ali"), people.imran, november)).toBeNull();
    expect(await getCommissionStatement(seller("sana"), people.ali, november)).toBeNull();
    expect(await codeOf(seller("zara"), sql`select * from app.commission_statement(${people.ali}::uuid, '2026-11-01', '2026-11-30')`)).toBe("42501");
    expect((await listStatements(seller("ali"), november)).people.map((p) => p.name)).toEqual(["ali@statements.test", "sana@statements.test"]);
    expect((await listStatements(seller("zara"), november)).people.map((p) => p.name)).toEqual(["zara@statements.test"]);
  });

  it("gives a manager everyone below them, at any depth, as the hierarchy stands", async () => {
    expect((await listStatements(imran, november)).people.map((p) => p.name)).toEqual(["ali@statements.test", "imran@statements.test", "sana@statements.test"]);
    expect(await getCommissionStatement(imran, people.sana, november)).not.toBeNull();
    expect(await getCommissionStatement(imran, people.zara, november)).toBeNull();
    await setManager(as.owner, people.ali, null);
    try {
      expect(await getCommissionStatement(imran, people.ali, november)).toBeNull();
      expect(await getCommissionStatement(imran, people.sana, november)).toBeNull();
    } finally {
      await setManager(as.owner, people.ali, people.imran);
    }
    expect(await getCommissionStatement(imran, people.ali, november)).not.toBeNull();
  });

  it("gives the owner, an accountant and the auditor everyone's, and no one from another company", async () => {
    for (const who of [as.owner, as.accountant, as.auditor]) expect((await getCommissionStatement(who, people.zara, november))?.statement.lines).toEqual([]);
    // An accountant who works in some branches only reads their own and their team's.
    expect(await getCommissionStatement(scoped, people.ali, november)).toBeNull();
    expect((await listStatements(scoped, november)).everyone).toBe(false);
    // Another company's owner: not a member here, so no statement; and nothing in their summary.
    expect(await getCommissionStatement(stranger, people.ali, november)).toBeNull();
    expect(await codeOf(stranger, sql`select * from app.commission_statement(${people.ali}::uuid, '2026-11-01', '2026-11-30')`)).toBe("42501");
    expect((await listStatements(stranger, november)).people).toEqual([]);
  });

  it("refuses a period the wrong way round or without an end", async () => {
    expect(await codeOf(as.owner, sql`select * from app.commission_statement(${people.ali}::uuid, '2026-11-30', '2026-11-01')`)).toBe("22023");
    expect(await codeOf(as.owner, sql`select * from app.commission_statement(${people.ali}::uuid, '-infinity', '2026-11-01')`)).toBe("22023");
    expect(await codeOf(as.owner, sql`select * from app.commission_statement_summary('2026-11-01', 'infinity')`)).toBe("22023");
  });
});
