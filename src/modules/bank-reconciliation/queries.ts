import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { reconcile, type BankLine, type BookLine, type Reconciliation } from "./rules";

// What the reconciliation screens read (Step 35). The policies let the owner, an accountant and
// the auditor who work in every branch read statements and matches.

export function requireReconcile(ctx: TenantContext): void {
  if (!can(ctx.role, "cash_bank.read")) throw new UserError("Your role does not include cash and bank.");
  if (ctx.branchIds !== null) throw new UserError("A bank account is reconciled by someone who works across the whole company.");
}

const exact = (value: string | null) => new Decimal(value ?? "0");

export type StatementRow = { id: string; fileName: string; from: string; to: string; lines: number; added: number; matched: number; opening: Decimal | null; closing: Decimal | null; importedAt: string };
export type UnmatchedBankLine = BankLine & { balance: Decimal | null };
export type UnmatchedBookLine = BookLine & { description: string };
export type MatchRow = { id: string; rule: string; amount: Decimal; matchedAt: string; bank: { date: string; description: string; amount: Decimal }[]; books: { date: string; number: string | null; amount: Decimal }[] };

export type ReconciliationPage = {
  account: { id: string; code: string; name: string };
  statements: StatementRow[];
  bankLines: UnmatchedBankLine[];
  bookLines: UnmatchedBookLine[];
  matches: MatchRow[];
  reconciliation: Reconciliation | null;
};

/** The company's bank accounts in use, for choosing which to reconcile. */
export async function listBankAccounts(ctx: TenantContext): Promise<{ id: string; label: string; lastStatement: string | null }[]> {
  requireReconcile(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; code: string; name: string; last: string | null }>(sql`
      select a.id, a.code, a.name, (select max(s.period_to)::text from public.bank_statements s where s.tenant_id = a.tenant_id and s.account_id = a.id) as last
      from public.accounts a
      where a.tenant_id = ${ctx.tenantId} and a.control_type = 'bank' and not a.is_group and a.archived_at is null
      order by a.code`),
  );
  return rows.map((r) => ({ id: r.id, label: `${r.code} ${r.name}`, lastStatement: r.last }));
}

/** The entries in the books on a bank account that no statement line has matched, with what names them. */
export async function selectUnmatchedBooks(tx: Tx, tenantId: string, accountId: string): Promise<UnmatchedBookLine[]> {
  const rows = await tx.execute<{ id: string; date: string; amount: string; number: string | null; cheque: string | null; description: string | null; memo: string | null }>(sql`
    select l.id, j.journal_date::text as date, (l.debit - l.credit)::text as amount, j.document_number as number, r.cheque_number as cheque, l.description, j.memo
    from public.journal_lines l
    join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
    left join public.receipts r on r.tenant_id = j.tenant_id and r.id = j.source_id
    where l.tenant_id = ${tenantId} and l.account_id = ${accountId}
      and not exists (select 1 from public.bank_match_journal_lines m where m.tenant_id = l.tenant_id and m.journal_line_id = l.id)
    order by j.journal_date, j.created_at, l.line_no
    limit 5000`);
  return rows.map((r) => ({ id: r.id, date: r.date, amount: exact(r.amount), documentNumber: r.number, chequeNumber: r.cheque, description: r.description ?? r.memo ?? "" }));
}

/** The statement lines of a bank account no entry in the books has matched. */
export async function selectUnmatchedBank(tx: Tx, tenantId: string, accountId: string): Promise<UnmatchedBankLine[]> {
  const rows = await tx.execute<{ id: string; date: string; amount: string; reference: string | null; description: string; balance: string | null }>(sql`
    select l.id, l.line_date::text as date, l.amount::text, l.reference, l.description, l.balance::text
    from public.bank_statement_lines l
    where l.tenant_id = ${tenantId} and l.account_id = ${accountId} and l.match_id is null
    order by l.line_date, l.created_at, l.line_no
    limit 5000`);
  return rows.map((r) => ({ id: r.id, date: r.date, amount: exact(r.amount), reference: r.reference, description: r.description, balance: r.balance === null ? null : exact(r.balance) }));
}

/** One bank account's reconciliation on a day (the last statement's last day, unless asked): what is matched, what is not, and the figures. */
export async function getReconciliationPage(ctx: TenantContext, accountId: string, asked?: string): Promise<ReconciliationPage | null> {
  requireReconcile(ctx);
  if (!isUuid(accountId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [account] = await tx.execute<{ id: string; code: string; name: string }>(sql`
      select a.id, a.code, a.name from public.accounts a where a.tenant_id = ${ctx.tenantId} and a.id = ${accountId} and a.control_type = 'bank' and not a.is_group`);
    if (!account) return null;
    const statements = await tx.execute<{ id: string; file_name: string; period_from: string; period_to: string; line_count: number; added_count: number; matched: number; opening: string | null; closing: string | null; imported_at: string }>(sql`
      select s.id, s.file_name, s.period_from::text, s.period_to::text, s.line_count, s.added_count, s.opening_balance::text as opening, s.closing_balance::text as closing, s.imported_at::text,
        (select count(*)::int from public.bank_statement_lines l where l.tenant_id = s.tenant_id and l.statement_id = s.id and l.match_id is not null) as matched
      from public.bank_statements s where s.tenant_id = ${ctx.tenantId} and s.account_id = ${accountId}
      order by s.period_from, s.imported_at`);
    const [bankLines, bookLines] = [await selectUnmatchedBank(tx, ctx.tenantId, accountId), await selectUnmatchedBooks(tx, ctx.tenantId, accountId)];
    const matchRows = await tx.execute<{ id: string; rule: string; amount: string; matched_at: string; side: "bank" | "books"; date: string; text: string | null; line_amount: string }>(sql`
      with recent as (select m.* from public.bank_matches m where m.tenant_id = ${ctx.tenantId} and m.account_id = ${accountId} order by m.matched_at desc limit 50)
      select m.id, m.rule, m.amount::text, m.matched_at::text, 'bank' as side, l.line_date::text as date, l.description as text, l.amount::text as line_amount
        from recent m join public.bank_statement_lines l on l.tenant_id = m.tenant_id and l.match_id = m.id
      union all
      select m.id, m.rule, m.amount::text, m.matched_at::text, 'books', j.journal_date::text, j.document_number, (jl.debit - jl.credit)::text
        from recent m join public.bank_match_journal_lines b on b.tenant_id = m.tenant_id and b.match_id = m.id
        join public.journal_lines jl on jl.tenant_id = b.tenant_id and jl.id = b.journal_line_id
        join public.journals j on j.tenant_id = jl.tenant_id and j.id = jl.journal_id
      order by 4 desc, 6`);
    const matches = new Map<string, MatchRow>();
    for (const row of matchRows) {
      const match = matches.get(row.id) ?? { id: row.id, rule: row.rule, amount: exact(row.amount), matchedAt: row.matched_at, bank: [], books: [] };
      if (row.side === "bank") match.bank.push({ date: row.date, description: row.text ?? "", amount: exact(row.line_amount) });
      else match.books.push({ date: row.date, number: row.text, amount: exact(row.line_amount) });
      matches.set(row.id, match);
    }

    let reconciliation: Reconciliation | null = null;
    if (statements.length > 0) {
      const asAt = asked ?? statements.map((s) => s.period_to).sort().at(-1)!;
      const startsOn = statements.map((s) => s.period_from).sort()[0];
      const first = statements.find((s) => s.period_from === startsOn)!;
      const lines = await tx.execute<{ side: "bank" | "books"; id: string; date: string; amount: string; match_id: string | null }>(sql`
        select 'bank' as side, l.id, l.line_date::text as date, l.amount::text, l.match_id from public.bank_statement_lines l where l.tenant_id = ${ctx.tenantId} and l.account_id = ${accountId}
        union all
        select 'books', l.id, j.journal_date::text, (l.debit - l.credit)::text, m.match_id
        from public.journal_lines l join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
        left join public.bank_match_journal_lines m on m.tenant_id = l.tenant_id and m.journal_line_id = l.id
        where l.tenant_id = ${ctx.tenantId} and l.account_id = ${accountId}`);
      const of = (side: "bank" | "books") => lines.filter((l) => l.side === side).map((l) => ({ id: l.id, date: l.date, amount: exact(l.amount), matchId: l.match_id }));
      reconciliation = reconcile(asAt, { startsOn, opening: first.opening === null ? null : exact(first.opening) }, of("bank"), of("books"));
    }
    return {
      account,
      statements: statements.map((s) => ({
        id: s.id,
        fileName: s.file_name,
        from: s.period_from,
        to: s.period_to,
        lines: s.line_count,
        added: s.added_count,
        matched: s.matched,
        opening: s.opening === null ? null : exact(s.opening),
        closing: s.closing === null ? null : exact(s.closing),
        importedAt: s.imported_at,
      })),
      bankLines,
      bookLines,
      matches: [...matches.values()],
      reconciliation,
    };
  });
}

export const today = () => todayIso(new Date());
