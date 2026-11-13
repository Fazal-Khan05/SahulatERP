import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { openFiscalYear, setPeriodLocked } from "@/modules/numbering/commands";
import { listFiscalPeriods } from "@/modules/numbering/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addAccount, deleteAccount, seedAccounts, setAccountArchived } from "./commands";
import { postJournal, reverseJournal } from "./posting";
import { getJournal, listAccounts } from "./queries";
import { JOURNAL_SOURCES, type AccountNode, type JournalLineInput } from "./rules";
import { journalLines, journals } from "./schema";

// The posting engine against a real database, through the app's own path (app_runtime,
// withTenant, row-level security), and the database's own rules tried directly as postgres.
// Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-posting-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const scopedAccountant = randomUUID();
const ownerB = randomUUID();
const mainBranch = randomUUID();
const cityBranch = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@posting.test`, tenantId, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const scoped = ctx(scopedAccountant, tenantA, "accountant", [cityBranch]);
const otherOwner = ctx(ownerB, tenantB, "owner");
const D = "2026-11-13";
const d = (value: string | number) => new Decimal(value);

let admin: AdminSql;
let chart: AccountNode[];
const account = (code: string) => {
  const found = chart.find((a) => a.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
};

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

/** Posts one manual-journal source in its own transaction, as the app would. */
const post = (who: TenantContext, lines: JournalLineInput[], more: { id?: string; date?: string; branchId?: string | null; memo?: string; documentNumber?: string } = {}) =>
  withTenant(who.userId, who.tenantId, (tx) => postJournal(tx, { type: "manual_journal", id: more.id ?? randomUUID(), date: more.date ?? D, branchId: more.branchId, memo: more.memo, documentNumber: more.documentNumber }, lines));
const reverse = (who: TenantContext, journalId: string, date = D, memo?: string) => withTenant(who.userId, who.tenantId, (tx) => reverseJournal(tx, journalId, { date, memo }));
/** Calls the database function directly, past the app's own checks. */
const rawPost = (who: TenantContext, lines: unknown, sourceType = "manual_journal", date = D) =>
  withTenant(who.userId, who.tenantId, (tx) => tx.execute(sql`select app.post_journal(${date}::date, ${sourceType}, ${randomUUID()}::uuid, ${JSON.stringify(lines)}::jsonb)`));
const rent = (amount: string): JournalLineInput[] => [
  { accountId: account("5230"), debit: d(amount), description: "Shop rent" },
  { accountId: account("1111"), credit: d(amount) },
];

/** A small repeatable random source, so a failing run can be run again. */
function randomSource(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!hasDb)("the posting engine", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${mainBranch}, ${tenantA}, 'Main', ${userIds.owner}), (${cityBranch}, ${tenantA}, 'City', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: scopedAccountant, email: scoped.email, role: "accountant", branch_ids: [cityBranch], created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await seedAccounts(as.owner, "trading");
    await seedAccounts(otherOwner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    await openFiscalYear(otherOwner, { month: "7", year: "2026" });
    chart = await listAccounts(as.owner);
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("posts 1,000 random balanced journals, and the books add up to exactly what was posted", async () => {
    const random = randomSource(20261113);
    const int = (from: number, to: number) => from + Math.floor(random() * (to - from + 1));
    // Any account a manual journal may touch: not a heading, not receivables, payables or stock.
    const blocked: readonly string[] = JOURNAL_SOURCES.manual_journal.blockedControls;
    const postable = chart.filter((a) => !a.isGroup && !blocked.includes(a.controlType ?? ""));
    const periods = await listFiscalPeriods(as.owner);
    const amount = () => d(int(1, 99_999_999)).div(10 ** int(0, 4)).toDecimalPlaces(4, Decimal.ROUND_DOWN).plus("0.0001");
    const expected = new Map<string, Decimal>();
    const move = (accountId: string, by: Decimal) => expected.set(accountId, (expected.get(accountId) ?? d(0)).plus(by));
    let grandTotal = d(0);

    const journalsToPost = Array.from({ length: 1000 }, () => {
      const debits = Array.from({ length: int(1, 3) }, amount);
      const total = debits.reduce((sum, value) => sum.plus(value), d(0));
      // The same total, cut into one to three credits.
      const credits: Decimal[] = [];
      let left = total;
      for (let parts = int(1, 3); parts > 1 && left.gt("0.0002"); parts -= 1) {
        const part = left.times(random()).toDecimalPlaces(4, Decimal.ROUND_DOWN);
        if (part.lte(0) || part.gte(left)) continue;
        credits.push(part);
        left = left.minus(part);
      }
      credits.push(left);
      const lines: JournalLineInput[] = [
        ...debits.map((value) => ({ accountId: postable[int(0, postable.length - 1)].id, debit: value })),
        ...credits.map((value) => ({ accountId: postable[int(0, postable.length - 1)].id, credit: value })),
      ];
      for (const line of lines) move(line.accountId, (line.debit ?? d(0)).minus(line.credit ?? d(0)));
      grandTotal = grandTotal.plus(total);
      const period = periods[int(0, periods.length - 1)];
      return { id: randomUUID(), date: `${period.startsOn.slice(0, 8)}${String(int(1, 28)).padStart(2, "0")}`, lines };
    });

    // Five at a time, as five people would; each batch is one transaction, as one document would be.
    const batches = Array.from({ length: 50 }, (_, i) => journalsToPost.slice(i * 20, i * 20 + 20));
    const worker = async () => {
      for (let batch = batches.pop(); batch; batch = batches.pop()) {
        const mine = batch;
        await withTenant(userIds.accountant, tenantA, async (tx) => {
          for (const journal of mine) await postJournal(tx, { type: "manual_journal", id: journal.id, date: journal.date }, journal.lines);
        });
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));

    const [totals] = await admin`
      select (select count(*)::int from public.journals where tenant_id = ${tenantA}) as journals,
        (select count(*)::int from public.journal_lines where tenant_id = ${tenantA}) as lines,
        (select sum(debit)::text from public.journal_lines where tenant_id = ${tenantA}) as debit,
        (select sum(credit)::text from public.journal_lines where tenant_id = ${tenantA}) as credit,
        (select count(*)::int from (select journal_id from public.journal_lines where tenant_id = ${tenantA} group by journal_id having sum(debit) <> sum(credit)) u) as unbalanced,
        (select count(*)::int from public.audit_log where tenant_id = ${tenantA} and action = 'journal.post') as audited`;
    expect(totals).toEqual({
      journals: 1000,
      lines: journalsToPost.reduce((sum, journal) => sum + journal.lines.length, 0),
      debit: grandTotal.toFixed(4),
      credit: grandTotal.toFixed(4),
      unbalanced: 0,
      audited: 1000,
    });
    // Account by account, the ledger holds exactly what was posted: nothing rounded, nothing misplaced.
    const balances = await admin<{ account_id: string; net: string }[]>`select account_id, (sum(debit) - sum(credit))::text as net from public.journal_lines where tenant_id = ${tenantA} group by account_id`;
    expect(balances).toHaveLength(expected.size);
    for (const row of balances) expect(row.net, row.account_id).toBe(expected.get(row.account_id)!.toFixed(4));
  });

  it("has the database, not the app, reject a journal that does not balance", async () => {
    // The app's own check comes first and says why.
    await expect(post(as.accountant, [{ accountId: account("5230"), debit: d("100") }, { accountId: account("1111"), credit: d("99.99") }])).rejects.toThrow("The journal does not balance: debits are 100.00 and credits are 99.99.");
    const before = (await admin`select count(*)::int as n from public.journals where tenant_id = ${tenantA}`)[0].n;

    // Past the app, the posting function refuses it.
    expect(await codeOf(() => rawPost(as.accountant, [{ account_id: account("5230"), debit: "100" }, { account_id: account("1111"), credit: "99.99" }]))).toBe("SE003");
    expect(await codeOf(() => rawPost(as.accountant, [{ account_id: account("5230"), debit: "100" }]))).toBe("SE003");
    // Past the function too, writing the rows directly as postgres, the commit is refused.
    const direct = (lines: { debit: string; credit: string }[], more: (tx: AdminSql) => Promise<unknown> = async () => {}) =>
      codeOf(() =>
        admin.begin(async (tx) => {
          const [journal] = await tx`insert into public.journals (tenant_id, journal_date, source_type, source_id, created_by) values (${tenantA}, ${D}, 'manual_journal', ${randomUUID()}, ${userIds.owner}) returning id`;
          for (const [index, line] of lines.entries()) {
            await tx`insert into public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit) values (${tenantA}, ${journal.id}, ${index + 1}, ${account(index === 0 ? "5230" : "1111")}, ${line.debit}, ${line.credit})`;
          }
          await more(tx as unknown as AdminSql);
        }),
      );
    expect(await direct([{ debit: "100", credit: "0" }, { debit: "0", credit: "90" }])).toBe("SE003");
    expect(await direct([{ debit: "100", credit: "0" }])).toBe("SE003");
    expect(await direct([])).toBe("SE003");
    // Checking early does not open a way round: a line added after the check is checked again.
    expect(
      await direct([{ debit: "100", credit: "0" }, { debit: "0", credit: "100" }], async (tx) => {
        await tx`set constraints all immediate`;
        const [journal] = await tx`select id from public.journals where tenant_id = ${tenantA} order by created_at desc, id limit 1`;
        await tx`insert into public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit) select tenant_id, journal_id, 3, account_id, 5, 0 from public.journal_lines where tenant_id = ${tenantA} and journal_id = ${journal.id} and line_no = 1`;
      }),
    ).toBe("SE003");
    // A balanced one written the same way is kept, which shows the refusals above were about balance.
    expect(await direct([{ debit: "100", credit: "0" }, { debit: "0", credit: "100" }])).toBeUndefined();
    expect((await admin`select count(*)::int as n from public.journals where tenant_id = ${tenantA}`)[0].n).toBe(before + 1);

    // A line is one debit or one credit, above zero, to four decimals at most.
    for (const bad of [
      [{ account_id: account("5230"), debit: "100", credit: "100" }, { account_id: account("1111"), credit: "0" }],
      [{ account_id: account("5230"), debit: "-100" }, { account_id: account("1111"), credit: "-100" }],
      [{ account_id: account("5230"), debit: "0" }, { account_id: account("1111"), credit: "0" }],
    ]) {
      expect(await codeOf(() => rawPost(as.accountant, bad)), JSON.stringify(bad)).toBe("23514");
    }
    expect(await codeOf(() => rawPost(as.accountant, [{ account_id: account("5230"), debit: "100.00005" }, { account_id: account("1111"), credit: "100.00005" }]))).toBe("23514");
    expect(await codeOf(() => rawPost(as.accountant, "not lines"))).toBe("SE003");
    // "Not a number" is a value the database's number type accepts, and it equals itself.
    for (const bad of [
      [{ account_id: account("5230"), debit: "NaN" }, { account_id: account("1111"), credit: "NaN" }],
      [{ account_id: account("5230"), debit: "100" }, { account_id: account("1111"), credit: "100" }, { account_id: account("5230"), debit: "NaN" }, { account_id: account("1111"), credit: "NaN" }],
    ]) {
      expect(await codeOf(() => rawPost(as.accountant, bad)), JSON.stringify(bad)).toBe("23514");
    }
    expect(
      await codeOf(() =>
        admin.begin(async (tx) => {
          const [journal] = await tx`insert into public.journals (tenant_id, journal_date, source_type, source_id, created_by) values (${tenantA}, ${D}, 'manual_journal', ${randomUUID()}, ${userIds.owner}) returning id`;
          await tx`insert into public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit) values (${tenantA}, ${journal.id}, 1, ${account("5230")}, 'NaN', 0), (${tenantA}, ${journal.id}, 2, ${account("1111")}, 0, 'NaN')`;
        }),
      ),
    ).toBe("23514");
    // A cost centre cannot be named until cost centres exist: a line could never be corrected.
    expect(await codeOf(() => rawPost(as.accountant, [{ account_id: account("5230"), debit: "1", cost_centre_id: randomUUID() }, { account_id: account("1111"), credit: "1" }]))).toBe("23514");
    // The check at the end of the transaction is the engine's own, whatever the caller set before.
    const early = await withTenant(userIds.accountant, tenantA, async (tx) => {
      await tx.execute(sql`set constraints all immediate`);
      return postJournal(tx, { type: "manual_journal", id: randomUUID(), date: D }, rent("3"));
    });
    expect((await getJournal(as.owner, early))?.lines).toHaveLength(2);
    // Text that is too long is refused in words, before the database is asked.
    await expect(post(as.owner, [{ accountId: account("5230"), debit: d("1"), description: "x".repeat(301) }, { accountId: account("1111"), credit: d("1") }])).rejects.toThrow("Line 1: use at most 300 characters for the description.");
    await expect(post(as.owner, rent("1"), { memo: "m".repeat(501) })).rejects.toThrow("use at most 500 characters");
  });

  it("never changes or removes a posted journal, whoever asks", async () => {
    const id = await post(as.accountant, rent("40000"), { memo: "  November rent ", documentNumber: "JV-2627-00001" });
    const stored = await getJournal(as.auditor, id);
    expect(stored).toMatchObject({ date: D, sourceType: "manual_journal", memo: "November rent", documentNumber: "JV-2627-00001", branchId: null, reversesJournalId: null, reversedByJournalId: null });
    expect(stored?.lines.map((l) => `${l.lineNo} ${l.accountCode} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)} ${l.description ?? ""}`)).toEqual(["1 5230 40000.00 0.00 Shop rent", "2 1111 0.00 40000.00 "]);

    // The app has no way to write the ledger except the posting function.
    const mine = sql`tenant_id = ${tenantA} and id = ${id}`;
    for (const who of [userIds.owner, userIds.accountant]) {
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.execute(sql`update public.journals set memo = 'changed' where ${mine}`)))).toBe("42501");
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.execute(sql`delete from public.journals where ${mine}`)))).toBe("42501");
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.execute(sql`update public.journal_lines set debit = 1 where tenant_id = ${tenantA} and journal_id = ${id}`)))).toBe("42501");
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.execute(sql`delete from public.journal_lines where tenant_id = ${tenantA} and journal_id = ${id}`)))).toBe("42501");
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(journals).values({ tenantId: tenantA, journalDate: D, sourceType: "manual_journal", sourceId: randomUUID(), createdBy: who })))).toBe("42501");
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(journalLines).values({ tenantId: tenantA, journalId: id, lineNo: 3, accountId: account("5230"), debit: "1" })))).toBe("42501");
    }
    // Even as postgres, with every privilege, the database refuses.
    expect(await codeOf(() => admin`update public.journals set memo = 'changed' where tenant_id = ${tenantA} and id = ${id}`)).toBe("SE020");
    expect(await codeOf(() => admin`update public.journal_lines set debit = debit + 1 where tenant_id = ${tenantA} and journal_id = ${id}`)).toBe("SE020");
    expect(await codeOf(() => admin`delete from public.journal_lines where tenant_id = ${tenantA} and journal_id = ${id}`)).toBe("SE020");
    expect(await codeOf(() => admin`delete from public.journals where tenant_id = ${tenantA} and id = ${id}`)).toBe("SE020");
    expect(await codeOf(() => admin`truncate public.journal_lines`)).toBe("SE020");
    expect(await codeOf(() => admin`truncate public.journals cascade`)).toBe("SE020");
    // Nothing joins a journal after the transaction that wrote it, balanced or not.
    expect(
      await codeOf(() =>
        admin.begin(async (tx) => {
          await tx`insert into public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit) values (${tenantA}, ${id}, 3, ${account("5230")}, 10, 0), (${tenantA}, ${id}, 4, ${account("1111")}, 0, 10)`;
        }),
      ),
    ).toBe("SE020");
    // Naming another company's ids for removal does not open this one.
    expect(
      await codeOf(() =>
        admin.begin(async (tx) => {
          await tx`select set_config('app.purge_tenants', ${tenantB}, true)`;
          await tx`delete from public.journal_lines where tenant_id = ${tenantA} and journal_id = ${id}`;
        }),
      ),
    ).toBe("SE020");
    expect((await getJournal(as.owner, id))?.lines).toHaveLength(2);
  });

  it("posts one journal per source document", async () => {
    const source = randomUUID();
    await post(as.owner, rent("100"), { id: source });
    await expect(post(as.owner, rent("100"), { id: source })).rejects.toThrow("This has already been posted.");
    // Two at the same moment: one is kept.
    const again = randomUUID();
    const both = await Promise.allSettled([post(as.owner, rent("7"), { id: again }), post(as.accountant, rent("7"), { id: again })]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await admin`select count(*)::int as n from public.journals where tenant_id = ${tenantA} and source_id in (${source}, ${again})`)[0].n).toBe(2);
    // The same document id in another company is that company's own.
    const elsewhere = await withTenant(ownerB, tenantB, async (tx) => {
      const theirs = await tx.execute<{ id: string; code: string }>(sql`select id, code from public.accounts where code in ('5230', '1111')`);
      const of = (code: string) => theirs.find((a) => a.code === code)!.id;
      return postJournal(tx, { type: "manual_journal", id: source, date: D }, [{ accountId: of("5230"), debit: d("100") }, { accountId: of("1111"), credit: d("100") }]);
    });
    expect(elsewhere).not.toBeNull();
  });

  it("reverses a journal once, with every debit and credit swapped", async () => {
    const id = await post(as.accountant, [{ accountId: account("5230"), debit: d("1250.5") }, { accountId: account("5810"), debit: d("49.5") }, { accountId: account("1111"), credit: d("1300") }], { branchId: cityBranch, documentNumber: "JV-2627-00009" });
    await expect(reverse(as.owner, id, "2026-11-12")).rejects.toThrow("A reversal is dated on or after the journal it reverses.");
    await expect(reverse(as.auditor, id)).rejects.toThrow("Your role cannot reverse this.");
    await expect(reverse(as.owner, randomUUID())).rejects.toThrow("That journal is not in this company.");
    await expect(reverse(otherOwner, id)).rejects.toThrow("That journal is not in this company.");
    // Whichever of the two gets there first is the one that is kept.
    const both = await Promise.allSettled([reverse(as.owner, id, "2026-11-20", "Entered twice"), reverse(as.accountant, id, "2026-11-20", "Entered twice")]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toBe("That journal has already been reversed.");
    const reversalId = (both.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>).value;

    const reversal = await getJournal(as.auditor, reversalId);
    expect(reversal).toMatchObject({ date: "2026-11-20", sourceType: "reversal", sourceId: id, reversesJournalId: id, branchId: cityBranch, documentNumber: null, memo: "Entered twice" });
    expect(reversal?.lines.map((l) => `${l.accountCode} ${l.debit.toFixed(2)} ${l.credit.toFixed(2)}`)).toEqual(["5230 0.00 1250.50", "5810 0.00 49.50", "1111 1300.00 0.00"]);
    expect((await getJournal(as.owner, id))?.reversedByJournalId).toBe(reversalId);
    // Together they leave nothing on any account.
    const net = await admin`select account_id from public.journal_lines where tenant_id = ${tenantA} and journal_id in (${id}, ${reversalId}) group by account_id having sum(debit) <> sum(credit)`;
    expect(net).toHaveLength(0);
    await expect(reverse(as.owner, id)).rejects.toThrow("That journal has already been reversed.");
    await expect(reverse(as.owner, reversalId)).rejects.toThrow("A reversal cannot be reversed. Post the journal again instead.");
    const [audited] = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'journal.reverse' and entity_id = ${reversalId}`;
    expect(audited.after).toEqual({ date: "2026-11-20", reverses: id, source: "manual_journal", reversesNumber: "JV-2627-00009", lines: 3, total: "1300.0000" });
  });

  it("refuses a date with no open period, and a locked one", async () => {
    await expect(post(as.owner, rent("10"), { date: "2026-06-30" })).rejects.toThrow("No fiscal period is open for 30-06-2026. An owner opens the fiscal year under Settings, Fiscal periods.");
    const august = (await listFiscalPeriods(as.owner)).find((p) => p.startsOn === "2026-08-01")!;
    const id = await post(as.owner, rent("10"), { date: "2026-08-10" });
    await setPeriodLocked(as.owner, august.id, true);
    await expect(post(as.accountant, rent("10"), { date: "2026-08-31" })).rejects.toThrow("The period August 2026 is locked. An owner can unlock it under Settings, Fiscal periods.");
    await expect(reverse(as.owner, id, "2026-08-15")).rejects.toThrow("The period August 2026 is locked.");
    // A journal in a locked month can still be reversed, dated in an open one.
    await reverse(as.owner, id, "2026-09-01");
    await setPeriodLocked(as.owner, august.id, false);
    await post(as.accountant, rent("10"), { date: "2026-08-31" });
  });

  it("lets only those who keep the books post, and only where a manual journal may", async () => {
    for (const role of ["auditor", "salesperson"] as const) await expect(post(as[role], rent("10")), role).rejects.toThrow("You are not allowed to post this: your role or your branches do not include it.");
    expect(await codeOf(() => rawPost(as.owner, [{ account_id: account("5230"), debit: "1" }, { account_id: account("1111"), credit: "1" }], "sales_invoice"))).toBe("23514");
    expect(await codeOf(() => rawPost(as.owner, [{ account_id: account("5230"), debit: "1" }, { account_id: account("1111"), credit: "1" }], "reversal"))).toBe("23514");
    // The accounts that must agree with records kept elsewhere are closed to a manual journal.
    for (const code of ["1200", "2110", "1300", "2130", "1210", "2120", "1310", "1130"]) {
      await expect(post(as.owner, [{ accountId: account(code), debit: d("5") }, { accountId: account("1111"), credit: d("5") }]), code).rejects.toThrow(`Account ${code} cannot be used in this kind of entry. It is kept by its own documents`);
    }
    await expect(post(as.owner, [{ accountId: account("5200"), debit: d("5") }, { accountId: account("1111"), credit: d("5") }])).rejects.toThrow("Account 5200 is a heading. Amounts go to the accounts under it.");
    await expect(post(as.owner, [{ accountId: randomUUID(), debit: d("5") }, { accountId: account("1111"), credit: d("5") }])).rejects.toThrow("An account, customer, supplier or branch on the journal is not in this company.");
    await expect(post(as.owner, rent("5"), { branchId: randomUUID() })).rejects.toThrow("An account, customer, supplier or branch on the journal is not in this company.");
    // Another company's account is not this company's, even by its real id.
    const theirs = (await listAccounts(otherOwner)).find((a) => a.code === "5230")!.id;
    await expect(post(as.owner, [{ accountId: theirs, debit: d("5") }, { accountId: account("1111"), credit: d("5") }])).rejects.toThrow("is not in this company");
    // A document number names one journal.
    await post(as.owner, rent("21"), { documentNumber: "JV-2627-00777" });
    await expect(post(as.owner, rent("22"), { documentNumber: "JV-2627-00777" })).rejects.toThrow("This has already been posted.");
    // A line on receivables names its customer, whoever writes it.
    expect(
      await codeOf(() =>
        admin.begin(async (tx) => {
          const [journal] = await tx`insert into public.journals (tenant_id, journal_date, source_type, source_id, created_by) values (${tenantA}, ${D}, 'manual_journal', ${randomUUID()}, ${userIds.owner}) returning id`;
          await tx`insert into public.journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit) values (${tenantA}, ${journal.id}, 1, ${account("1200")}, 10, 0)`;
        }),
      ),
    ).toBe("SE013");
    const lineAs = (code: string, party: Record<string, string>) =>
      codeOf(() =>
        admin.begin(async (tx) => {
          const [journal] = await tx`insert into public.journals (tenant_id, journal_date, source_type, source_id, created_by) values (${tenantA}, ${D}, 'manual_journal', ${randomUUID()}, ${userIds.owner}) returning id`;
          await tx`insert into public.journal_lines ${tx({ tenant_id: tenantA, journal_id: journal.id, line_no: 1, account_id: account(code), debit: 0, credit: 10, ...party })}`;
        }),
      );
    expect(await lineAs("2110", {})).toBe("SE014");
    expect(await lineAs("1210", {})).toBe("SE014");
    expect(await lineAs("2130", {})).toBe("SE013");
    // A customer of another company is not this company's customer.
    const [theirCustomer] = await admin`insert into public.customers (tenant_id, name, registration_type, atl_status, created_by, updated_by) values (${tenantB}, 'Their customer', 'unregistered', 'unknown', ${ownerB}, ${ownerB}) returning id`;
    expect(await lineAs("1200", { customer_id: theirCustomer.id })).toBe("23503");
  });

  it("makes an owner locking a month wait for a journal already on its way in", async () => {
    const december = (await listFiscalPeriods(as.owner)).find((p) => p.startsOn === "2026-12-01")!;
    let locked = false;
    let lock: Promise<void> = Promise.resolve();
    const id = await withTenant(userIds.accountant, tenantA, async (tx) => {
      const journal = await postJournal(tx, { type: "manual_journal", id: randomUUID(), date: "2026-12-05" }, rent("9"));
      // The journal is written but its transaction is still open: the lock has to wait for it.
      lock = setPeriodLocked(as.owner, december.id, true).then(() => void (locked = true));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(locked).toBe(false);
      return journal;
    });
    await lock;
    expect(locked).toBe(true);
    // The journal that was on its way is in; nothing more gets in, a reversal included.
    expect(await getJournal(as.owner, id)).not.toBeNull();
    await expect(post(as.owner, rent("9"), { date: "2026-12-06" })).rejects.toThrow("The period December 2026 is locked.");
    await expect(reverse(as.owner, id, "2026-12-07")).rejects.toThrow("The period December 2026 is locked.");
    await setPeriodLocked(as.owner, december.id, false);
  });

  it("keeps a member limited to some branches to those branches", async () => {
    const company = await post(as.owner, rent("11"));
    const main = await post(as.owner, rent("12"), { branchId: mainBranch });
    const city = await post(scoped, rent("13"), { branchId: cityBranch });
    await expect(post(scoped, rent("14"))).rejects.toThrow("You are not allowed to post this");
    await expect(post(scoped, rent("14"), { branchId: mainBranch })).rejects.toThrow("You are not allowed to post this");
    // A branch of another company is not one of this member's branches either.
    const theirBranch = (await admin`insert into public.branches (tenant_id, name, created_by) values (${tenantB}, 'Theirs', ${ownerB}) returning id`)[0].id;
    await expect(post(scoped, rent("14"), { branchId: theirBranch })).rejects.toThrow("You are not allowed to post this");
    await expect(post(as.owner, rent("14"), { branchId: theirBranch })).rejects.toThrow("is not in this company");
    expect(await getJournal(scoped, city)).not.toBeNull();
    expect(await getJournal(scoped, main)).toBeNull();
    expect(await getJournal(scoped, company)).toBeNull();
    // The lines carry the journal's branch, so they are hidden with it.
    const seen = await withTenant(scopedAccountant, tenantA, (tx) => tx.execute<{ branch_id: string | null }>(sql`select distinct branch_id from public.journal_lines`));
    expect(seen.map((r) => r.branch_id)).toEqual([cityBranch]);
    await expect(reverse(scoped, main)).rejects.toThrow("That journal is not in this company.");
    // Each company sees only its own ledger.
    expect(await getJournal(otherOwner, company)).toBeNull();
    expect(await withTenant(userIds.salesperson, tenantA, (tx) => tx.select().from(journals))).toEqual([]);
    expect(await withTenant(ownerB, tenantA, (tx) => tx.select().from(journalLines))).toEqual([]);
  });

  it("refuses to delete an account with postings; an archived account takes no new ones", async () => {
    const rentAccount = account("5230");
    await expect(deleteAccount(as.owner, rentAccount)).rejects.toThrow("This account has postings, so it cannot be deleted. Archive it instead");
    const id = await post(as.owner, rent("77"));
    await setAccountArchived(as.owner, rentAccount, true);
    await expect(post(as.owner, rent("78"))).rejects.toThrow("Account 5230 is archived. Restore it, or choose another account.");
    // What was posted can still be reversed.
    await reverse(as.owner, id);
    await setAccountArchived(as.owner, rentAccount, false);
  });

  it("holds the same list of sources in the database as in the app", async () => {
    for (const [type, source] of Object.entries(JOURNAL_SOURCES)) {
      const [row] = await admin`select app.journal_source_roles(${type})::text[] as roles, app.journal_source_reversal_roles(${type})::text[] as reversal, app.journal_source_blocked_controls(${type}) as blocked`;
      expect(row, type).toEqual({ roles: [...source.roles], reversal: [...source.reversalRoles], blocked: [...source.blockedControls] });
    }
    const [unknown] = await admin`select app.journal_source_roles('made_up') as roles, app.journal_source_reversal_roles('made_up') as reversal, app.journal_source_blocked_controls('made_up') as blocked`;
    expect(unknown).toEqual({ roles: null, reversal: null, blocked: [] });
  });

  // The worked example in docs/examples/step-13.md, posted for real in the other company.
  it("posts the worked example exactly as written", async () => {
    const theirs = await listAccounts(otherOwner);
    const of = (code: string) => theirs.find((a) => a.code === code)!.id;
    const bank = await addAccount(otherOwner, { parentId: of("1120"), name: "HBL current account", code: "", kind: "account" });
    const run = (id: string, date: string, memo: string, lines: JournalLineInput[]) => withTenant(ownerB, tenantB, (tx) => postJournal(tx, { type: "manual_journal", id, date, memo }, lines));
    const before = (await admin`select count(*)::int as n from public.journals where tenant_id = ${tenantB}`)[0].n;
    const rentId = await run(randomUUID(), "2026-11-02", "Shop rent for November 2026, paid in cash", [
      { accountId: of("5230"), debit: d("40000") },
      { accountId: of("1111"), credit: d("40000") },
    ]);
    await run(randomUUID(), "2026-11-05", "Owner's money put into the business", [
      { accountId: bank.id, debit: d("450000") },
      { accountId: of("1111"), debit: d("50000") },
      { accountId: of("3100"), credit: d("500000") },
    ]);
    const reversalId = await withTenant(ownerB, tenantB, (tx) => reverseJournal(tx, rentId, { date: "2026-11-10", memo: "Rent was entered twice" }));
    expect((await admin`select count(*)::int as n from public.journals where tenant_id = ${tenantB}`)[0].n).toBe(before + 3);
    const reversal = await getJournal(otherOwner, reversalId);
    expect(reversal?.lines.map((l) => `${l.accountCode} ${l.accountName} | ${l.debit.toFixed(2)} | ${l.credit.toFixed(2)}`)).toEqual(["5230 Rent | 0.00 | 40000.00", "1111 Cash in hand | 40000.00 | 0.00"]);
    // What the three journals leave on each account (this company's earlier test journal aside).
    const balances = await admin`
      select a.code, (sum(l.debit) - sum(l.credit))::text as net
      from public.journal_lines l
      join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ${tenantB} and j.journal_date between '2026-11-02' and '2026-11-10' and j.memo is not null
      group by a.code order by a.code`;
    expect(balances.map((b) => `${b.code} ${b.net}`)).toEqual(["1111 50000.0000", "1121 450000.0000", "3100 -500000.0000", "5230 0.0000"]);
  });
});
