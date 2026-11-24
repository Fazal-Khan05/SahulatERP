import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenant/rules";
import { createWarehouse } from "@/modules/warehouses/commands";
import { listWarehouses } from "@/modules/warehouses/queries";
import { warehouses } from "@/modules/warehouses/schema";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { enterAs } from "../../../tests/support/identity";
import { openFiscalYear, setPeriodLocked, takeJournalNumber } from "./commands";
import { listFiscalPeriods, listNumberSeries } from "./queries";
import { formatDocumentNumber, periodRefusal } from "./rules";
import { fiscalPeriods, numberSeries } from "./schema";

// Fiscal periods, document numbers and warehouses against a real database, through the app's
// own path (app_runtime, withTenant, row-level security). Skipped when the database URLs are absent.
//
// A number is taken by the database function that posts the document, which runs as the owner
// of the database for the member the transaction says it is. The app's role cannot ask for one
// (only for a manual journal's, and that one has to be used). So the numbering itself is tried
// here as those functions call it: on the owner's connection, after saying who the member is.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-number-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "salesperson", "warehouse_manager", "auditor"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();
const mainBranch = randomUUID();
const cityBranch = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}@number.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role, role === "warehouse_manager" ? [cityBranch] : null)])) as Record<(typeof roles)[number], TenantContext>;
const otherOwner = ctx(ownerB, tenantB, "owner");
const DENIED = "42501";
const CHECK = "23514";
const D = "2026-11-13";

let admin: AdminSql;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
type OwnerTx = postgres.TransactionSql;
let posting: AdminSql;
/** The next number, as a posting function takes it. A refusal leaves the transaction usable, and reads as the app words it. */
async function take(tx: OwnerTx, type: string, date: string): Promise<string> {
  try {
    const rows = await tx.savepoint((inner) => inner<{ number: string }[]>`select app.next_document_number(${type}, ${date}::date) as number`);
    return rows[0].number;
  } catch (error) {
    const refused = periodRefusal((error as { code?: string }).code, date);
    if (refused) throw new UserError(refused);
    throw error;
  }
}
/** One transaction of a posting function, for a member. */
const posted = <T>(who: { userId: string; tenantId: string }, run: (tx: OwnerTx) => Promise<T>) =>
  posting.begin(async (tx) => {
    await enterAs(tx, who.userId, who.tenantId);
    return run(tx);
  }) as Promise<T>;
/** One document's transaction: takes its number and, if told to, fails afterwards. */
const post = (who: TenantContext, type: string, date: string, fail = false) =>
  posted(who, async (tx) => {
    const number = await take(tx, type, date);
    if (fail) throw new Error("the document failed after taking its number");
    return number;
  });

describe.skipIf(!hasDb)("fiscal periods, document numbers and warehouses", () => {
  beforeAll(async () => {
    admin = adminSql();
    posting = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 10, onnotice: () => {} });
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenantA}, 'City', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: role === "warehouse_manager" ? [cityBranch] : null, created_by: userIds.owner })),
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await posting.end();
    await admin.end();
    await closeDb();
  }, 120_000);

  it("numbers nothing until an owner opens a fiscal year", async () => {
    await expect(post(as.salesperson, "SI", D)).rejects.toThrow("No fiscal period is open for 13-11-2026. An owner opens the fiscal year under Settings, Fiscal periods.");
    for (const role of ["accountant", "salesperson", "auditor"] as const) {
      await expect(openFiscalYear(as[role], { month: "7", year: "2026" }), role).rejects.toThrow("Only an owner can open a fiscal year.");
    }
    await expect(openFiscalYear(as.owner, { month: "13", year: "2026" })).rejects.toThrow("Choose the month the fiscal year starts.");
    await expect(openFiscalYear(as.owner, { month: "7", year: "2062" })).rejects.toThrow("The first fiscal year must start between");
    // Two owners' clicks at the same moment open one year, not two.
    const twice = await Promise.allSettled([openFiscalYear(as.owner, { month: "7", year: "2026" }), openFiscalYear(as.owner, { month: "7", year: "2026" })]);
    expect(twice.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await listFiscalPeriods(as.owner)).length).toBe(24);
    // The second of the two calls above waited, saw the first year open and opened the one after it.
    const periods = await listFiscalPeriods(as.salesperson);
    expect(periods).toHaveLength(24);
    expect([periods[0].startsOn, periods[0].endsOn, periods[11].endsOn, periods[12].startsOn, periods[19].endsOn, periods[23].endsOn]).toEqual(["2026-07-01", "2026-07-31", "2027-06-30", "2027-07-01", "2028-02-29", "2028-06-30"]);
    const audited = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'fiscal_year.open' order by at`;
    expect(audited).toEqual([
      { actor_role: "owner", after: { year: "2026-27", from: "2026-07-01" } },
      { actor_role: "owner", after: { year: "2027-28", from: "2027-07-01" } },
    ]);
  }, 120_000);

  it("gives 20 documents posted at the same moment consecutive numbers with no gap", async () => {
    const numbers = await Promise.all(Array.from({ length: 20 }, () => post(as.salesperson, "SI", D)));
    expect([...numbers].sort()).toEqual(Array.from({ length: 20 }, (_, i) => formatDocumentNumber("SI", "2627", i + 1)));
    expect(numbers[0]).toMatch(/^SI-2627-000\d\d$/);

    // Twenty more, five of which fail after taking a number: the failures give theirs back, so the
    // fifteen that succeed still run on without a gap.
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => post(as.accountant, "SI", D, i % 4 === 0)));
    const kept = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<string>).value);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(5);
    expect(kept.sort()).toEqual(Array.from({ length: 15 }, (_, i) => formatDocumentNumber("SI", "2627", i + 21)));
    expect(await listNumberSeries(as.auditor)).toEqual([{ documentType: "SI", yearStart: "2026-07-01", yearCode: "2627", nextNumber: 36 }]);
  }, 120_000);

  it("counts each kind of document and each fiscal year on its own", async () => {
    expect(await post(as.salesperson, "PO", D)).toBe("PO-2627-00001");
    expect(await post(as.salesperson, "PO", "2026-07-01")).toBe("PO-2627-00002");
    expect(await post(as.salesperson, "SI", "2027-07-01")).toBe("SI-2728-00001"); // the counter restarts with the year
    expect(await post(as.salesperson, "SI", "2027-06-30")).toBe("SI-2627-00036");
    await expect(post(as.salesperson, "SI", "2028-07-01")).rejects.toThrow("No fiscal period is open for 01-07-2028.");
    // A company on the calendar year writes the year in full.
    await openFiscalYear(otherOwner, { month: "1", year: "2026" });
    expect(await post(otherOwner, "SI", D)).toBe("SI-2026-00001");
    expect((await listNumberSeries(otherOwner)).map((s) => [s.documentType, s.yearCode, s.nextNumber])).toEqual([["SI", "2026", 2]]);
  }, 60_000);

  it("refuses a locked period, for an owner to lock and unlock", async () => {
    const periods = await listFiscalPeriods(as.owner);
    const november = periods.find((p) => p.startsOn === "2026-11-01")!;
    for (const role of ["accountant", "salesperson", "auditor"] as const) {
      await expect(setPeriodLocked(as[role], november.id, true), role).rejects.toThrow("Only an owner can lock or unlock a period.");
    }
    await setPeriodLocked(as.owner, november.id, true);
    await setPeriodLocked(as.owner, november.id, true); // twice is once
    await expect(post(as.salesperson, "SI", D)).rejects.toThrow("The period November 2026 is locked. An owner can unlock it under Settings, Fiscal periods.");
    // A refusal leaves the rest of the transaction usable, and other periods are untouched.
    const number = await posted(as.salesperson, async (tx) => {
      await expect(take(tx, "SI", D)).rejects.toBeInstanceOf(UserError);
      return take(tx, "SI", "2026-10-31");
    });
    expect(number).toBe("SI-2627-00037");
    await setPeriodLocked(as.owner, november.id, false);
    expect(await post(as.salesperson, "SI", D)).toBe("SI-2627-00038");

    // A lock waits for a document already on its way in: the document keeps its number, and the
    // lock lands only after it. Nothing gets a number in the month once the lock is in place.
    const order: string[] = [];
    let numberTaken!: () => void;
    const hasNumber = new Promise<void>((resolve) => (numberTaken = resolve));
    const slowPost = posted(as.salesperson, async (tx) => {
      const taken = await take(tx, "SI", D);
      numberTaken();
      // The document is still being written while the owner reaches for the lock.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      order.push("document");
      return taken;
    });
    await hasNumber;
    const locking = setPeriodLocked(as.owner, november.id, true).then(() => order.push("lock"));
    expect(await slowPost).toBe("SI-2627-00039");
    await locking;
    expect(order).toEqual(["document", "lock"]);
    await expect(post(as.salesperson, "SI", D)).rejects.toThrow("The period November 2026 is locked.");
    await setPeriodLocked(as.owner, november.id, false);
    expect(await post(as.salesperson, "SI", D)).toBe("SI-2627-00040");
    const [row] = await admin`select locked_at, locked_by from public.fiscal_periods where id = ${november.id}`;
    expect(row).toEqual({ locked_at: null, locked_by: null });
    const audited = await admin`select action, after from public.audit_log where entity_id = ${november.id} order by at`;
    expect(audited.slice(0, 2)).toEqual([
      { action: "fiscal_period.lock", after: { period: "November 2026", locked: true } },
      { action: "fiscal_period.unlock", after: { period: "November 2026", locked: false } },
    ]);
    expect(audited.map((a) => a.action.split(".")[1])).toEqual(["lock", "unlock", "lock", "unlock"]);
    await expect(setPeriodLocked(as.owner, randomUUID(), true)).rejects.toThrow("That period is not in this company.");
  }, 60_000);

  it("keeps the counter out of the app's hands, whatever the app does", async () => {
    const owner = userIds.owner;
    // The app can read a counter but never set one, move one or remove one.
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(numberSeries).values({ tenantId: tenantA, documentType: "SI", yearStart: "2028-07-01", yearCode: "2829", nextNumber: 500 })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(numberSeries).set({ nextNumber: 1 })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.delete(numberSeries)))).toBe(DENIED);
    expect(await withTenant(userIds.salesperson, tenantA, (tx) => tx.select().from(numberSeries))).toEqual([]);
    await expect(listNumberSeries(as.salesperson)).rejects.toBeInstanceOf(UserError);
    // An auditor takes no numbers; a kind the database does not know is refused.
    expect(await codeOf(() => post(as.auditor, "SI", D))).toBe(DENIED);
    expect(await codeOf(() => post(as.owner, "si", D))).toBe(CHECK);
    const zz = () => post(as.owner, "ZZ", D);
    expect(await codeOf(zz)).toBe(CHECK);
    // A later step numbers a kind of its own by adding one function (drizzle/0019_journal_documents.sql).
    await admin.unsafe("drop function if exists app.document_type_zz()");
    await admin.unsafe("create function app.document_type_zz() returns text language sql immutable as 'select ''Test document'''");
    try {
      expect(await zz()).toMatch(/^ZZ-\d{4}-00001$/);
    } finally {
      await admin.unsafe("drop function if exists app.document_type_zz()");
    }
    expect(await codeOf(zz)).toBe(CHECK);
    expect(await codeOf(() => post(as.owner, "Z1", D))).toBe(CHECK);
    // A period sits only where its year and number put it.
    expect(
      await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(fiscalPeriods).values({ tenantId: tenantA, yearStart: "2028-07-01", periodNo: 7, startsOn: "2030-02-01", endsOn: "2030-02-28", createdBy: owner }))),
    ).toBe(CHECK);
    // Periods: only an owner writes them; a month is a whole month; its dates and year are fixed; nothing is deleted.
    const period = { tenantId: tenantA, yearStart: "2028-07-01", periodNo: 1, startsOn: "2028-07-01", endsOn: "2028-07-31" };
    expect(await codeOf(() => withTenant(userIds.accountant, tenantA, (tx) => tx.insert(fiscalPeriods).values({ ...period, createdBy: userIds.accountant })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(fiscalPeriods).values({ ...period, endsOn: "2028-07-30", createdBy: owner })))).toBe(CHECK);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.insert(fiscalPeriods).values({ ...period, yearStart: "2026-07-01", startsOn: "2026-07-01", endsOn: "2026-07-31", createdBy: owner })))).toBe("23505");
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(fiscalPeriods).set({ startsOn: "2020-01-01" })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.update(fiscalPeriods).set({ lockedAt: new Date(), lockedBy: ownerB })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(userIds.accountant, tenantA, (tx) => tx.update(fiscalPeriods).set({ lockedAt: new Date(), lockedBy: userIds.accountant })))).toBeUndefined(); // touches no rows
    expect(await codeOf(() => withTenant(owner, tenantA, (tx) => tx.delete(fiscalPeriods)))).toBe(DENIED);
    expect(await admin`select count(*)::int as n, count(locked_at)::int as locked from public.fiscal_periods where tenant_id = ${tenantA}`).toEqual([{ n: 24, locked: 0 }]);
    expect((await listNumberSeries(as.owner)).find((s) => s.documentType === "SI" && s.yearCode === "2627")?.nextNumber).toBe(41);
  }, 120_000);

  it("lets nobody take a number and throw it away", async () => {
    // Found by the reviewer of Step 24: any member could call the numbering function and leave a
    // gap in a series. The app's role can no longer call it at all.
    for (const role of roles) {
      for (const type of ["SI", "PO", "GR", "JV"]) {
        expect(await codeOf(() => withTenant(userIds[role], tenantA, (tx) => tx.execute(`select app.next_document_number('${type}', '${D}')`))), `${role} ${type}`).toBe(DENIED);
      }
    }
    // The one number the app takes for itself is a manual journal's, and only those who write journals may.
    for (const role of ["salesperson", "warehouse_manager", "auditor"] as const) {
      expect(await codeOf(() => withTenant(userIds[role], tenantA, (tx) => tx.execute(`select app.next_journal_number('${D}')`))), role).toBe(DENIED);
    }
    expect(await codeOf(() => withTenant(userIds.owner, tenantB, (tx) => tx.execute(`select app.next_journal_number('${D}')`)))).toBe(DENIED);
    // Taken and not used, the transaction does not end: the number goes back.
    for (const role of ["owner", "accountant"] as const) {
      expect(await codeOf(() => withTenant(userIds[role], tenantA, (tx) => takeJournalNumber(tx, D))), role).toBe("SE004");
      expect(await codeOf(() => withTenant(userIds[role], tenantA, (tx) => tx.execute(`select app.next_journal_number('${D}'), app.next_journal_number('${D}')`))), role).toBe("SE004");
    }
    // Nor by asking for the check early, nor by writing a journal that only looks like it carries the number.
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, async (tx) => {
      await takeJournalNumber(tx, D);
      await tx.execute(`set constraints all immediate`);
    }))).toBe("SE004");
    expect((await listNumberSeries(as.owner)).filter((s) => s.documentType === "JV")).toEqual([]);
    await expect(withTenant(userIds.owner, tenantA, (tx) => takeJournalNumber(tx, "13-11-2026"))).rejects.toThrow("A journal needs a date before it can be numbered.");
    await expect(withTenant(userIds.owner, tenantA, (tx) => takeJournalNumber(tx, "2031-01-01"))).rejects.toThrow("No fiscal period is open for 01-01-2031.");

    // A manual journal that is posted keeps its number: src/modules/manual-journals/journals.test.ts.
  }, 120_000);

  it("adds warehouses to branches, seen by members who work in those branches", async () => {
    const main = (await createWarehouse(as.owner, { name: "Main godown", branchId: mainBranch })).id;
    await createWarehouse(as.owner, { name: "City shop store", branchId: cityBranch });
    await expect(createWarehouse(as.owner, { name: "MAIN GODOWN", branchId: cityBranch })).rejects.toThrow("A warehouse with this name already exists.");
    await expect(createWarehouse(as.owner, { name: "", branchId: mainBranch })).rejects.toThrow("Enter the warehouse name, in up to 80 characters.");
    await expect(createWarehouse(as.owner, { name: "Nowhere", branchId: randomUUID() })).rejects.toThrow("Choose the branch the warehouse belongs to.");
    for (const role of ["accountant", "warehouse_manager", "auditor"] as const) {
      await expect(createWarehouse(as[role], { name: "Mine", branchId: cityBranch }), role).rejects.toThrow("Only an owner can add a warehouse.");
    }
    expect((await listWarehouses(as.accountant)).map((w) => [w.name, w.branch])).toEqual([["City shop store", "City"], ["Main godown", "Main"]]);
    // The warehouse manager works in the City branch only.
    expect((await listWarehouses(as.warehouse_manager)).map((w) => w.name)).toEqual(["City shop store"]);
    const [audited] = await admin`select actor_role, action, after from public.audit_log where entity_id = ${main}`;
    expect(audited).toEqual({ actor_role: "owner", action: "warehouse.create", after: { name: "Main godown", branch: "Main" } });
    expect(await codeOf(() => withTenant(userIds.accountant, tenantA, (tx) => tx.insert(warehouses).values({ tenantId: tenantA, branchId: mainBranch, name: "Direct", createdBy: userIds.accountant })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(warehouses).set({ name: "Renamed" })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.delete(warehouses)))).toBe(DENIED);
  }, 120_000);

  it("keeps each company's periods, counters and warehouses to itself", async () => {
    expect((await listFiscalPeriods(otherOwner)).map((p) => p.startsOn)[0]).toBe("2026-01-01");
    expect(await listWarehouses(otherOwner)).toEqual([]);
    const theirs = (await listFiscalPeriods(otherOwner))[0];
    await expect(setPeriodLocked(as.owner, theirs.id, true)).rejects.toThrow("That period is not in this company.");
    // A's owner, asking as if in B, sees and numbers nothing.
    expect(await withTenant(userIds.owner, tenantB, (tx) => tx.select().from(fiscalPeriods))).toEqual([]);
    expect(await withTenant(userIds.owner, tenantB, (tx) => tx.select().from(numberSeries))).toEqual([]);
    expect(await codeOf(() => post({ ...as.owner, tenantId: tenantB }, "SI", D))).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerB, tenantB, (tx) => tx.insert(warehouses).values({ tenantId: tenantB, branchId: mainBranch, name: "Planted", createdBy: ownerB })))).toBe("23503");
    expect((await listNumberSeries(otherOwner)).map((s) => s.nextNumber)).toEqual([2]);
  }, 120_000);
});
