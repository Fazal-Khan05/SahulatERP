import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import type { ObjectStore } from "@/lib/storage";
import { addCashBankAccount, cancelExpense, recordExpense } from "@/modules/cash-bank/commands";
import { getExpense, listExpenses } from "@/modules/cash-bank/queries";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { attachReceipt, previewExpenseSheet, readExpenseSheetFile, recordDailyExpense, recordExpenseSheet } from "./commands";
import { getDailyChoices, getReceiptFile, listDailyExpenses, listReceipts } from "./queries";
import type { SheetCells } from "./rules";

// Daily expenses against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): the quick entry that names nobody, receipts and who may keep and see
// them, and a sheet entered whole or not at all. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-daily-expenses-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();
const lahoreBranch = randomUUID();
const karachiBranch = randomUUID();
const branchClerk = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], tenantId = tenantA, branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@daily.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const lahoreAccountant = ctx(branchClerk, "accountant", tenantA, [lahoreBranch]);
const otherOwner = ctx(ownerB, "owner", tenantB);
// A day of the fiscal year the company opens, which has come; and one of a year it has not opened.
const DAY = "2026-10-20";
const NEXT_DAY = "2026-10-21";
const BEFORE_THE_BOOKS = "2026-05-15";
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

let admin: AdminSql;
let cash: string;
let bank: string;
let rent: string;
let fuel: string;
let rentName: string;
let fuelName: string;
let stockAccount: string;

function memoryStore(options: { fail?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    async put(key, bytes) {
      if (options.fail) throw new Error("store is down");
      objects.set(key, bytes);
    },
    async signedDownloadUrl(key) {
      return `memory://${key}`;
    },
  };
  return { store, objects };
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
const journal = async (number: string) =>
  (
    await admin<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' / ' || trim_scale(l.credit)::text || coalesce(' ' || l.description, '') as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantA} and j.document_number = ${number} order by l.line_no`
  ).map((r) => r.line);
const expenseCount = async () => (await admin<{ n: number }[]>`select count(*)::int as n from public.expenses where tenant_id = ${tenantA}`)[0].n;
const account = async (tenant: string, code: string) => (await admin<{ id: string; name: string }[]>`select id, name from public.accounts where tenant_id = ${tenant} and code = ${code}`)[0];
/**
 * What the object store's policies ask, signed in as someone. The two functions answer from who
 * auth.uid() says is signed in and nothing else, so they are asked here with that set; that the
 * object store's role may call them, and nothing else, is in src/modules/tenant/policies.test.ts.
 */
const storeAsks = async (userId: string, fn: "storage_receipt_writer" | "storage_receipt_reader", key: string) =>
  admin.begin(async (tx) => {
    await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
    const [row] = fn === "storage_receipt_writer" ? await tx<{ ok: boolean }[]>`select app.storage_receipt_writer(${key}) as ok` : await tx<{ ok: boolean }[]>`select app.storage_receipt_reader(${key}) as ok`;
    return row.ok;
  });
const sheet = (rows: Partial<SheetCells>[]): SheetCells[] => rows.map((row, index) => ({ row: index + 2, date: "20/10/2026", whatFor: rentName, amount: "100", paidFrom: "Cash in hand", paidTo: "", note: "", ...row }));

describe.skipIf(!hasDb)("daily expenses", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${lahoreBranch}, ${tenantA}, 'Lahore', ${userIds.owner}), (${karachiBranch}, ${tenantA}, 'Karachi', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: branchClerk, email: lahoreAccountant.email, role: "accountant", branch_ids: [lahoreBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    for (const who of [as.owner, otherOwner]) {
      await admin`insert into public.company_setup (tenant_id, sales_tax_registered, accounts_template, completed_by) values (${who.tenantId}, false, 'trading', ${who.userId})`;
      await admin`select app.seed_tax_defaults(${who.tenantId}, ${who.userId})`;
      await setBaseCurrency(who, { code: "PKR", name: "Pakistani Rupee" });
      await seedAccounts(who, "trading");
      await openFiscalYear(who, { month: "7", year: "2026" });
    }
    cash = (await account(tenantA, "1111")).id;
    bank = (await addCashBankAccount(as.owner, { kind: "bank", name: "HBL current account" })).id;
    const spend = await admin<{ id: string; name: string }[]>`
      select id, name from public.accounts where tenant_id = ${tenantA} and type = 'expense' and not is_group and control_type is null and archived_at is null order by code limit 2`;
    [rent, fuel] = spend.map((a) => a.id);
    [rentName, fuelName] = spend.map((a) => a.name);
    stockAccount = (await admin<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantA} and type = 'asset' and not is_group and control_type is null and archived_at is null limit 1`)[0].id;
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("records a daily expense that names nobody, as an ordinary expense with its journal and its number", async () => {
    const tea = await recordDailyExpense(as.owner, { date: DAY, whatForId: fuel, amount: "1,200", paidFromId: cash });
    expect(tea.number).toBe("EX-2627-00001");
    const code = async (id: string) => (await admin<{ code: string }[]>`select code from public.accounts where id = ${id}`)[0].code;
    // With nobody named and no note, the journal and the money's line say what it was for: the account's name.
    expect(await journal(tea.number)).toEqual([`${await code(fuel)} 1200 / 0 ${fuelName}`, `1111 0 / 1200 ${fuelName}`]);
    const [row] = await admin<{ supplier_id: string | null; payee: string | null; memo: string | null; total: string; paid: string; withheld: string; status: string; journal_memo: string }[]>`
      select e.supplier_id, e.payee, e.memo, e.total::numeric(20,2)::text, e.paid::numeric(20,2)::text, e.withheld::numeric(20,2)::text, e.status, j.memo as journal_memo
      from public.expenses e join public.journals j on j.id = e.journal_id where e.id = ${tea.id}`;
    expect(row).toEqual({ supplier_id: null, payee: null, memo: null, total: "1200.00", paid: "1200.00", withheld: "0.00", status: "posted", journal_memo: fuelName });
    expect(await admin`select 1 from public.audit_log where tenant_id = ${tenantA} and entity_id = ${tea.id} and action = 'expense.record'`).toHaveLength(1);

    // With a note and someone named: the note is what it was for, and the journal says who was paid.
    const van = await recordDailyExpense(as.accountant, { date: DAY, whatForId: fuel, amount: "3500.50", paidFromId: bank, paidTo: "Shell, Mall Road", note: "Petrol for the van" });
    expect(await journal(van.number)).toEqual([`${await code(fuel)} 3500.5 / 0 Petrol for the van`, `${await code(bank)} 0 / 3500.5 Paid to Shell, Mall Road`]);

    // The full screen shows both; one that names nobody has no "paid to".
    expect((await getExpense(as.auditor, tea.id))?.paidTo).toBeNull();
    expect((await listExpenses(as.auditor)).map((e) => `${e.number} ${e.paidTo}`)).toEqual(["EX-2627-00002 Shell, Mall Road", "EX-2627-00001 null"]);
  });

  it("lists the days asked for, newest first, with what each row was for", async () => {
    await recordDailyExpense(as.owner, { date: NEXT_DAY, whatForId: rent, amount: "45000", paidFromId: bank, paidTo: "Landlord" });
    const { rows, more } = await listDailyExpenses(as.auditor, DAY, NEXT_DAY);
    expect(more).toBe(false);
    expect(rows.map((r) => `${r.date} ${r.number} ${r.whatFor} | ${r.description} | ${r.paidTo} | ${r.from} | ${r.total.toFixed(2)} | ${r.receipts}`)).toEqual([
      `${NEXT_DAY} EX-2627-00003 ${rentName} | ${rentName} | Landlord | HBL current account | 45000.00 | 0`,
      `${DAY} EX-2627-00002 ${fuelName} | Petrol for the van | Shell, Mall Road | HBL current account | 3500.50 | 0`,
      `${DAY} EX-2627-00001 ${fuelName} | ${fuelName} | null | Cash in hand | 1200.00 | 0`,
    ]);
    expect((await listDailyExpenses(as.owner, DAY, DAY)).rows).toHaveLength(2);
    await expect(listDailyExpenses(as.salesperson, DAY, NEXT_DAY)).rejects.toThrow("Your role does not include cash and bank.");
  });

  it("offers the expense accounts by name and the cash and bank accounts, and remembers what this person paid from last", async () => {
    const owner = await getDailyChoices(as.owner);
    expect(owner.expenseAccounts.map((a) => a.id)).toEqual(expect.arrayContaining([rent, fuel]));
    expect(owner.expenseAccounts.map((a) => a.id)).not.toContain(stockAccount);
    expect(owner.moneyAccounts.map((a) => `${a.kind} ${a.name}`)).toEqual(["cash Cash in hand", "bank HBL current account"]);
    expect(owner.lastPaidFromId).toBe(bank);
    expect((await getDailyChoices(as.auditor)).lastPaidFromId).toBeNull();
  });

  it("records an entry sent twice once, and refuses the same form sent again with other figures", async () => {
    const before = await expenseCount();
    const entry = { date: DAY, whatForId: rent, amount: "250", paidFromId: cash, clientKey: randomUUID() };
    const first = await recordDailyExpense(as.owner, entry);
    expect(await recordDailyExpense(as.owner, entry)).toEqual(first);
    expect(await expenseCount()).toBe(before + 1);
    await expect(recordDailyExpense(as.owner, { ...entry, amount: "900" })).rejects.toThrow("already sent with other figures");
    // Two entries alike in every figure, each with its own key, are two expenses.
    await recordDailyExpense(as.owner, { ...entry, clientKey: randomUUID() });
    expect(await expenseCount()).toBe(before + 2);
  });

  it("refuses what will not do, in plain words, and records nothing", async () => {
    const before = await expenseCount();
    const entry = { date: DAY, whatForId: rent, amount: "100", paidFromId: cash };
    await expect(recordDailyExpense(as.owner, { ...entry, whatForId: stockAccount })).rejects.toThrow("Choose what it was for from the company's expense accounts in use.");
    await expect(recordDailyExpense(as.owner, { ...entry, whatForId: cash })).rejects.toThrow("Choose what it was for from the company's expense accounts in use.");
    await expect(recordDailyExpense(as.owner, { ...entry, whatForId: (await account(tenantB, "1111")).id })).rejects.toThrow("Choose what it was for from the company's expense accounts in use.");
    await expect(recordDailyExpense(as.owner, { ...entry, whatForId: "not-an-id" })).rejects.toThrow("Choose the accounts again");
    await expect(recordDailyExpense(as.owner, { ...entry, paidFromId: rent })).rejects.toThrow("Choose two different cash or bank accounts");
    await expect(recordDailyExpense(as.owner, { ...entry, paidFromId: (await account(tenantB, "1111")).id })).rejects.toThrow("Choose two different cash or bank accounts");
    await expect(recordDailyExpense(as.owner, { ...entry, date: "2099-01-01" })).rejects.toThrow("That date has not come yet.");
    await expect(recordDailyExpense(as.owner, { ...entry, date: BEFORE_THE_BOOKS })).rejects.toThrow("No fiscal period is open for 15-05-2026");
    await expect(recordDailyExpense(as.owner, { ...entry, branchId: randomUUID() })).rejects.toThrow("Choose one of your branches.");
    expect(await expenseCount()).toBe(before);
  });

  it("still asks who was paid on the full expense form, and never takes a supplier and a name together", async () => {
    const line = [{ accountId: rent, description: "Repairs", amount: "100" }];
    await expect(recordExpense(as.owner, { date: DAY, accountId: bank, lines: line })).rejects.toThrow("Choose the supplier, or name who was paid.");
    const supplier = (await createParty(as.owner, "supplier", { name: "Daily Parts", supplierType: "aop" })).id;
    const lines = JSON.stringify([{ account: rent, description: "Repairs", amount: "100.00" }]);
    // Past the app: the database takes a supplier, a name, or neither; both together it refuses.
    expect(await codeOf(as.owner, sql`select app.record_expense(gen_random_uuid(), ${DAY}::date, ${bank}::uuid, ${supplier}::uuid, 'Someone', null, null, null, ${lines}::jsonb, null, null)`)).toBe("SE337");
    expect(await codeOf(as.owner, sql`select app.record_expense(gen_random_uuid(), ${DAY}::date, ${bank}::uuid, null, 'S', null, null, null, ${lines}::jsonb, null, null)`)).toBe("SE337");
    // Tax is still withheld only from a supplier on the list.
    expect(await codeOf(as.owner, sql`select app.record_expense(gen_random_uuid(), ${DAY}::date, ${bank}::uuid, null, null, null, null, null, ${lines}::jsonb, 'income_tax.services.other', null)`)).toBe("SE338");
    // A row that names both cannot be written by anyone.
    await expect(admin`update public.expenses set payee = 'Someone', supplier_id = ${supplier} where tenant_id = ${tenantA} and number = 'EX-2627-00001'`).rejects.toThrow();
  });

  it("is entered by the owner and an accountant, read by the auditor, and closed to everyone else", async () => {
    const entry = { date: DAY, whatForId: rent, amount: "100", paidFromId: cash };
    for (const role of ["auditor", "salesperson"] as const) {
      await expect(recordDailyExpense(as[role], entry), role).rejects.toThrow("Only the owner or an accountant moves or spends the company's money.");
      await expect(recordExpenseSheet(as[role], { cells: sheet([{}]), branchId: "", clientKey: randomUUID() }), role).rejects.toThrow("Only the owner or an accountant");
      await expect(previewExpenseSheet(as[role], sheet([{}]), ""), role).rejects.toThrow("Only the owner or an accountant");
    }
    await expect(getDailyChoices(as.salesperson)).rejects.toThrow("Your role does not include cash and bank.");
    // Another company sees none of it.
    expect((await listDailyExpenses(otherOwner, DAY, NEXT_DAY)).rows).toEqual([]);
  });

  it("keeps a branch's accountant to their branch", async () => {
    const entry = { date: DAY, whatForId: rent, amount: "800", paidFromId: cash, note: "Tap for the Lahore shop" };
    await expect(recordDailyExpense(lahoreAccountant, entry)).rejects.toThrow("Choose one of your branches.");
    await expect(recordDailyExpense(lahoreAccountant, { ...entry, branchId: karachiBranch })).rejects.toThrow("Choose one of your branches.");
    const tap = await recordDailyExpense(lahoreAccountant, { ...entry, branchId: lahoreBranch });
    expect((await listDailyExpenses(lahoreAccountant, DAY, NEXT_DAY)).rows.map((r) => r.number)).toEqual([tap.number]);
    expect((await getDailyChoices(lahoreAccountant)).lastPaidFromId).toBe(cash);
    // A sheet of theirs is for one of their branches too.
    await expect(previewExpenseSheet(lahoreAccountant, sheet([{}]), "")).rejects.toThrow("Choose one of your branches.");
    await expect(previewExpenseSheet(lahoreAccountant, sheet([{}]), karachiBranch)).rejects.toThrow("Choose one of your branches.");
    expect((await previewExpenseSheet(lahoreAccountant, sheet([{}]), lahoreBranch))[0].expense?.branchId).toBe(lahoreBranch);
  });

  describe("receipts", () => {
    let first: string;
    let lahoreExpense: string;
    let ownerReceipt: string;
    let ownerFile: string;

    beforeAll(async () => {
      first = (await admin<{ id: string }[]>`select id from public.expenses where tenant_id = ${tenantA} and number = 'EX-2627-00001'`)[0].id;
      lahoreExpense = (await admin<{ id: string }[]>`select id from public.expenses where tenant_id = ${tenantA} and branch_id = ${lahoreBranch} limit 1`)[0].id;
    });

    it("keeps a PDF or a photo with an expense: the intent first, the bytes, then the outcome with its audit row", async () => {
      const { store, objects } = memoryStore();
      ownerReceipt = (await attachReceipt(as.owner, store, first, { name: "folder/Bill رسید.pdf", bytes: PDF })).id;
      const [row] = await admin<{ file_id: string; name: string; status: string; content_type: string; size_bytes: number; storage_key: string; created_by: string }[]>`
        select r.file_id, f.name, f.status, f.content_type, f.size_bytes, f.storage_key, r.created_by
        from public.expense_receipts r join public.files f on f.id = r.file_id where r.id = ${ownerReceipt}`;
      ownerFile = row.file_id;
      expect(row).toEqual({ file_id: ownerFile, name: "Bill رسید.pdf", status: "stored", content_type: "application/pdf", size_bytes: PDF.length, storage_key: `${tenantA}/${ownerFile}`, created_by: userIds.owner });
      expect(objects.get(`${tenantA}/${ownerFile}`)).toEqual(PDF);
      const audit = await admin<{ actor_role: string; after: Record<string, unknown> }[]>`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'expense_receipt.attach' and entity_id = ${first}`;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_role: "owner", after: { number: "EX-2627-00001", receipt: ownerReceipt, file: ownerFile, name: "Bill رسید.pdf" } });
      // An accountant keeps one too: a photo.
      await attachReceipt(as.accountant, store, first, { name: "photo.jpg", bytes: JPEG });
      expect((await listReceipts(as.auditor, first)).map((r) => `${r.name} ${r.contentType} ${r.sizeBytes} ${r.addedBy}`)).toEqual([
        `Bill رسید.pdf application/pdf ${PDF.length} ${as.owner.email}`,
        `photo.jpg image/jpeg ${JPEG.length} ${as.accountant.email}`,
      ]);
      expect((await listDailyExpenses(as.owner, DAY, DAY)).rows.find((r) => r.id === first)?.receipts).toBe(2);
    });

    it("opens a receipt for whoever may see its expense, and for no one else", async () => {
      for (const who of [as.owner, as.accountant, as.auditor]) expect(await getReceiptFile(who, ownerReceipt), who.role).toEqual({ storageKey: `${tenantA}/${ownerFile}`, name: "Bill رسید.pdf" });
      await expect(getReceiptFile(as.salesperson, ownerReceipt)).rejects.toThrow("Your role does not include cash and bank.");
      expect(await getReceiptFile(otherOwner, ownerReceipt)).toBeNull();
      expect(await listReceipts(otherOwner, first)).toEqual([]);
      // The expense is the whole company's: a branch's accountant does not see it, nor its receipts.
      expect(await getReceiptFile(lahoreAccountant, ownerReceipt)).toBeNull();
      expect(await listReceipts(lahoreAccountant, first)).toEqual([]);
      expect(await getReceiptFile(as.owner, "not-an-id")).toBeNull();
    });

    it("lets an accountant read a file only when it is their own or a receipt they may see", async () => {
      // A file of the owner's that is no receipt: the company's logo, say.
      const other = randomUUID();
      await admin`insert into public.files (id, tenant_id, storage_key, name, content_type, size_bytes, status, stored_at, created_by)
        values (${other}, ${tenantA}, ${`${tenantA}/${other}`}, 'Agreement.pdf', 'application/pdf', 10, 'stored', now(), ${userIds.owner})`;
      const seen = async (who: TenantContext) => (await withTenant(who.userId, who.tenantId, (tx) => tx.execute<{ name: string }>(sql`select name from public.files where tenant_id = ${tenantA} order by name`))).map((r) => r.name);
      expect(await seen(as.accountant)).toEqual(["Bill رسید.pdf", "photo.jpg"]);
      expect(await seen(as.owner)).toEqual(["Agreement.pdf", "Bill رسید.pdf", "photo.jpg"]);
      expect(await seen(lahoreAccountant)).toEqual([]);
      expect(await seen(as.salesperson)).toEqual([]);
      // An accountant stores only a pending file of their own, in their own company, and changes no one else's.
      const id = randomUUID();
      const mine = sql`insert into public.files (id, tenant_id, storage_key, name, content_type, size_bytes, created_by) values (${id}, ${tenantA}, ${`${tenantA}/${id}`}, 'a.pdf', 'application/pdf', 10, `;
      expect(await codeOf(as.accountant, sql`${mine}${userIds.owner})`)).toBe("42501");
      expect(await codeOf(as.salesperson, sql`${mine}${userIds.salesperson})`)).toBe("42501");
      expect(await codeOf(as.auditor, sql`${mine}${userIds.auditor})`)).toBe("42501");
      const touched = await withTenant(as.accountant.userId, tenantA, (tx) => tx.execute(sql`update public.files set status = 'pending', stored_at = null where id = ${other} returning id`));
      expect(touched).toHaveLength(0);
    });

    it("lets the object store take an accountant's own pending file and give back a receipt, and nothing more", async () => {
      const pending = randomUUID();
      const key = `${tenantA}/${pending}`;
      await admin`insert into public.files (id, tenant_id, storage_key, name, content_type, size_bytes, created_by) values (${pending}, ${tenantA}, ${key}, 'new.pdf', 'application/pdf', 10, ${userIds.accountant})`;
      expect(await storeAsks(userIds.accountant, "storage_receipt_writer", key)).toBe(true);
      // Not someone else's row, not a key with no row, not a salesperson's, not once it is stored.
      expect(await storeAsks(branchClerk, "storage_receipt_writer", key)).toBe(false);
      expect(await storeAsks(userIds.accountant, "storage_receipt_writer", `${tenantA}/${randomUUID()}`)).toBe(false);
      expect(await storeAsks(userIds.accountant, "storage_receipt_writer", `${tenantB}/${pending}`)).toBe(false);
      expect(await storeAsks(userIds.accountant, "storage_receipt_writer", `${tenantA}/${ownerFile}`)).toBe(false);
      // Reading: their own file, or a receipt of an expense in a branch they work in.
      expect(await storeAsks(userIds.accountant, "storage_receipt_reader", key)).toBe(true);
      expect(await storeAsks(userIds.accountant, "storage_receipt_reader", `${tenantA}/${ownerFile}`)).toBe(true);
      expect(await storeAsks(branchClerk, "storage_receipt_reader", `${tenantA}/${ownerFile}`)).toBe(false);
      expect(await storeAsks(userIds.salesperson, "storage_receipt_reader", `${tenantA}/${ownerFile}`)).toBe(false);
      expect(await storeAsks(ownerB, "storage_receipt_reader", `${tenantA}/${ownerFile}`)).toBe(false);
      // The two policies are there, for the files bucket only.
      const policies = await admin<{ policyname: string; cmd: string; roles: string[] }[]>`select policyname, cmd, roles::text[] as roles from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'files_bucket_%_receipt' order by 1`;
      expect(policies.map((p) => `${p.policyname} ${p.cmd} ${p.roles.join()}`)).toEqual(["files_bucket_insert_receipt INSERT authenticated", "files_bucket_select_receipt SELECT authenticated"]);
      await admin`delete from public.files where id = ${pending}`;
    });

    it("keeps a branch accountant's receipt to those who see that branch", async () => {
      const { store } = memoryStore();
      const receipt = await attachReceipt(lahoreAccountant, store, lahoreExpense, { name: "tap.jpg", bytes: JPEG });
      expect((await getReceiptFile(lahoreAccountant, receipt.id))?.name).toBe("tap.jpg");
      expect((await getReceiptFile(as.accountant, receipt.id))?.name).toBe("tap.jpg");
      const [file] = await admin<{ storage_key: string }[]>`select f.storage_key from public.expense_receipts r join public.files f on f.id = r.file_id where r.id = ${receipt.id}`;
      expect(await storeAsks(branchClerk, "storage_receipt_reader", file.storage_key)).toBe(true);
      // And they cannot add one to an expense outside their branch.
      await expect(attachReceipt(lahoreAccountant, store, first, { name: "x.pdf", bytes: PDF })).rejects.toThrow("That expense is not in this company.");
    });

    it("refuses what cannot be a receipt before anything is stored, and claims nothing when the store is down", async () => {
      const { store, objects } = memoryStore();
      const filesBefore = (await admin<{ n: number }[]>`select count(*)::int as n from public.files where tenant_id = ${tenantA}`)[0].n;
      await expect(attachReceipt(as.owner, store, first, { name: "notes.txt", bytes: new TextEncoder().encode("hello") })).rejects.toThrow("A receipt is a PDF, or a photo as PNG, JPEG or WebP.");
      await expect(attachReceipt(as.owner, store, first, { name: "big.pdf", bytes: new Uint8Array(4 * 1024 * 1024 + 1) })).rejects.toThrow("The file must be 4 MB or smaller.");
      await expect(attachReceipt(as.owner, store, first, { name: "", bytes: PDF })).rejects.toThrow("The file needs a name.");
      await expect(attachReceipt(as.owner, store, randomUUID(), { name: "a.pdf", bytes: PDF })).rejects.toThrow("That expense is not in this company.");
      await expect(attachReceipt(otherOwner, store, first, { name: "a.pdf", bytes: PDF })).rejects.toThrow("That expense is not in this company.");
      for (const role of ["auditor", "salesperson"] as const) await expect(attachReceipt(as[role], store, first, { name: "a.pdf", bytes: PDF }), role).rejects.toThrow("Only the owner or an accountant");
      expect(objects.size).toBe(0);
      expect((await admin<{ n: number }[]>`select count(*)::int as n from public.files where tenant_id = ${tenantA}`)[0].n).toBe(filesBefore);
      // The store is down: the file row stays pending, and no receipt is claimed.
      await expect(attachReceipt(as.owner, memoryStore({ fail: true }).store, first, { name: "down.pdf", bytes: PDF })).rejects.toThrow("store is down");
      const [left] = await admin<{ status: string; receipts: number }[]>`
        select f.status, (select count(*)::int from public.expense_receipts r where r.file_id = f.id) as receipts from public.files f where f.tenant_id = ${tenantA} and f.name = 'down.pdf'`;
      expect(left).toEqual({ status: "pending", receipts: 0 });
      expect(await listReceipts(as.owner, first)).toHaveLength(2);
    });

    it("lets no one but the database's own function write a receipt or its audit row", async () => {
      expect(await codeOf(as.owner, sql`insert into public.expense_receipts (tenant_id, expense_id, file_id, created_by) values (${tenantA}, ${first}, ${ownerFile}, ${userIds.owner})`)).toBe("42501");
      expect(await codeOf(as.owner, sql`delete from public.expense_receipts where id = ${ownerReceipt}`)).toBe("42501");
      expect(await codeOf(as.owner, sql`update public.expense_receipts set expense_id = ${lahoreExpense} where id = ${ownerReceipt}`)).toBe("42501");
      expect(await codeOf(as.owner, sql`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after) values (${tenantA}, ${userIds.owner}, 'owner', 'expense_receipt.attach', 'expense', ${first}, '{}'::jsonb)`)).toBe("42501");
      // The function itself: a file already a receipt, someone else's file, a file not yet stored, an expense elsewhere, a role that keeps none.
      expect(await codeOf(as.owner, sql`select app.attach_expense_receipt(${lahoreExpense}::uuid, ${ownerFile}::uuid)`)).toBe("SE376");
      const accountantFile = (await admin<{ id: string }[]>`select id from public.files where tenant_id = ${tenantA} and name = 'photo.jpg'`)[0].id;
      const pendingFile = (await admin<{ id: string }[]>`select id from public.files where tenant_id = ${tenantA} and name = 'down.pdf'`)[0].id;
      expect(await codeOf(as.owner, sql`select app.attach_expense_receipt(${lahoreExpense}::uuid, ${accountantFile}::uuid)`)).toBe("SE376");
      expect(await codeOf(as.owner, sql`select app.attach_expense_receipt(${first}::uuid, ${pendingFile}::uuid)`)).toBe("SE376");
      expect(await codeOf(otherOwner, sql`select app.attach_expense_receipt(${first}::uuid, ${ownerFile}::uuid)`)).toBe("SE334");
      expect(await codeOf(as.auditor, sql`select app.attach_expense_receipt(${first}::uuid, ${ownerFile}::uuid)`)).toBe("42501");
      expect(await codeOf(as.salesperson, sql`select app.attach_expense_receipt(${first}::uuid, ${ownerFile}::uuid)`)).toBe("42501");
    });

    it("keeps at most ten with an expense, and keeps them when the expense is cancelled", async () => {
      const { store } = memoryStore();
      const spare = await recordDailyExpense(as.owner, { date: DAY, whatForId: rent, amount: "10", paidFromId: cash, note: "Ten receipts" });
      for (let i = 1; i <= 10; i++) await attachReceipt(as.owner, store, spare.id, { name: `${i}.pdf`, bytes: PDF });
      await expect(attachReceipt(as.owner, store, spare.id, { name: "11.pdf", bytes: PDF })).rejects.toThrow("An expense has at most ten receipts.");
      // Past the app's own count, the database holds the line.
      const extra = randomUUID();
      await admin`insert into public.files (id, tenant_id, storage_key, name, content_type, size_bytes, status, stored_at, created_by)
        values (${extra}, ${tenantA}, ${`${tenantA}/${extra}`}, 'extra.pdf', 'application/pdf', 10, 'stored', now(), ${userIds.owner})`;
      expect(await codeOf(as.owner, sql`select app.attach_expense_receipt(${spare.id}::uuid, ${extra}::uuid)`)).toBe("SE377");
      await cancelExpense(as.owner, spare.id, { date: DAY, reason: "Entered to test receipts" });
      expect(await listReceipts(as.auditor, spare.id)).toHaveLength(10);
      const row = (await listDailyExpenses(as.owner, DAY, DAY)).rows.find((r) => r.id === spare.id);
      expect(row).toMatchObject({ status: "cancelled", receipts: 10 });
    });
  });

  describe("a sheet of expenses", () => {
    it("reads an Excel workbook and a CSV file alike", async () => {
      const book = new ExcelJS.Workbook();
      const page = book.addWorksheet("Expenses");
      page.addRow(["Date", "What for", "Amount", "Paid from", "Paid to", "Note"]);
      page.addRow([new Date(Date.UTC(2026, 9, 20)), rentName, 45000, "HBL current account", "Landlord", "October"]);
      page.addRow(["21/10/2026", fuelName, 1250.5, "Cash in hand", null, null]);
      const workbook = await readExpenseSheetFile(as.owner, new Uint8Array(await book.xlsx.writeBuffer()));
      const wanted = [
        { row: 2, date: "2026-10-20", whatFor: rentName, amount: "45000", paidFrom: "HBL current account", paidTo: "Landlord", note: "October" },
        { row: 3, date: "21/10/2026", whatFor: fuelName, amount: "1250.5", paidFrom: "Cash in hand", paidTo: "", note: "" },
      ];
      expect(workbook).toEqual({ ok: true, cells: wanted });
      const csv = `﻿Date,What for,Amount,Paid from,Paid to,Note\r\n2026-10-20,"${rentName}",45000,HBL current account,Landlord,October\r\n21/10/2026,"${fuelName}",1250.5,Cash in hand,,\r\n`;
      expect(await readExpenseSheetFile(as.owner, new TextEncoder().encode(csv))).toEqual({ ok: true, cells: wanted });
      expect(await readExpenseSheetFile(as.owner, new Uint8Array())).toMatchObject({ ok: false });
      expect(await readExpenseSheetFile(as.owner, new TextEncoder().encode("just,some,text\n1,2,3\n"))).toMatchObject({ ok: false, reason: expect.stringContaining("The first row must name the columns") });
      expect(await readExpenseSheetFile(as.owner, new Uint8Array(1024 * 1024 + 1))).toMatchObject({ ok: false, reason: expect.stringContaining("too large") });
      // No file is opened for someone who may not enter expenses.
      for (const role of ["auditor", "salesperson"] as const) await expect(readExpenseSheetFile(as[role], new TextEncoder().encode(csv)), role).rejects.toThrow("Only the owner or an accountant");
    });

    it("shows what each row would enter and what is wrong with it, and enters nothing", async () => {
      const before = await expenseCount();
      const rows = await previewExpenseSheet(as.accountant, sheet([{ whatFor: fuelName.toUpperCase(), amount: "1,250.50", paidFrom: "hbl current account", note: "Petrol" }, { whatFor: "Tea and biscuits" }, { date: "31/02/2026", amount: "lots" }]), "");
      expect(rows.map((r) => r.problems)).toEqual([[], ['No expense account is called "Tea and biscuits". Use a name from the list on this page.'], ['"31/02/2026" is not a date. Write it as 26/11/2026 or 2026-11-26.', '"lots" is not an amount. Write rupees above nothing, such as 500 or 1,250.50.']]);
      expect(rows[0]).toMatchObject({ whatForName: fuelName, paidFromName: "HBL current account" });
      expect(rows[0].expense).toMatchObject({ date: DAY, whatForId: fuel, paidFromId: bank, note: "Petrol", branchId: null });
      expect(await expenseCount()).toBe(before);
    });

    it("enters every row or none: one bad row, in the sheet or at the database, and nothing is entered", async () => {
      const before = await expenseCount();
      const numbered = async () => (await admin<{ n: string }[]>`select coalesce(max(number), '') as n from public.expenses where tenant_id = ${tenantA}`)[0].n;
      const last = await numbered();
      await expect(recordExpenseSheet(as.owner, { cells: sheet([{}, { whatFor: "Tea and biscuits" }, {}]), branchId: "", clientKey: randomUUID() })).rejects.toThrow('Nothing was entered. Row 3: No expense account is called "Tea and biscuits".');
      // The third row passes every check of the sheet and is refused by the database: a day before the books were opened.
      await expect(recordExpenseSheet(as.owner, { cells: sheet([{}, {}, { date: "15/05/2026" }, {}]), branchId: "", clientKey: randomUUID() })).rejects.toThrow("Nothing was entered. Row 4: No fiscal period is open for 15-05-2026");
      expect(await expenseCount()).toBe(before);
      // No number was taken by the rows before the one refused.
      const next = await recordDailyExpense(as.owner, { date: DAY, whatForId: rent, amount: "1", paidFromId: cash });
      expect(Number(next.number.slice(-5))).toBe(Number(last.slice(-5)) + 1);
      await expect(recordExpenseSheet(as.owner, { cells: [], branchId: "", clientKey: randomUUID() })).rejects.toThrow("The sheet has no expenses in it.");
      await expect(recordExpenseSheet(as.owner, { cells: sheet([{}]), branchId: "", clientKey: "x" })).rejects.toThrow("Upload the sheet again.");
    });

    it("enters a good sheet in its order, each row an expense of its own, and once however often it is sent", async () => {
      const before = await expenseCount();
      const cells = sheet([{ amount: "45,000", paidFrom: "HBL current account", paidTo: "Landlord", note: "October rent" }, { whatFor: fuelName, amount: "1250.5", date: "2026-10-21" }, { whatFor: fuelName, amount: "300" }]);
      const clientKey = randomUUID();
      const entered = await recordExpenseSheet(as.accountant, { cells, branchId: lahoreBranch, clientKey });
      expect(entered).toMatchObject({ count: 3, total: "46550.50" });
      expect(Number(entered.last.slice(-5)) - Number(entered.first.slice(-5))).toBe(2);
      expect(await expenseCount()).toBe(before + 3);
      const made = await admin<{ d: string; payee: string | null; total: string; branch_id: string; description: string; created_by: string }[]>`
        select e.expense_date::text as d, e.payee, e.total::numeric(20,2)::text, e.branch_id, l.description, e.created_by
        from public.expenses e join public.expense_lines l on l.expense_id = e.id
        where e.tenant_id = ${tenantA} and e.number >= ${entered.first} and e.number <= ${entered.last} order by e.number`;
      expect(made.map((m) => `${m.d} ${m.payee} ${m.total} ${m.description}`)).toEqual([`${DAY} Landlord 45000.00 October rent`, `${NEXT_DAY} null 1250.50 ${fuelName}`, `${DAY} null 300.00 ${fuelName}`]);
      expect(made.every((m) => m.branch_id === lahoreBranch && m.created_by === userIds.accountant)).toBe(true);
      // The same sheet sent again (a second press, a retry) enters nothing more.
      expect(await recordExpenseSheet(as.accountant, { cells, branchId: lahoreBranch, clientKey })).toEqual(entered);
      expect(await expenseCount()).toBe(before + 3);
      // Every journal of the company still balances.
      const [books] = await admin<{ off: string }[]>`select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as off from public.journal_lines l where l.tenant_id = ${tenantA}`;
      expect(books.off).toBe("0.00");
    });
  });
});
