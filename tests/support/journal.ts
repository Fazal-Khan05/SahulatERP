import { randomInt, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { postJournal, reverseJournal } from "@/modules/ledger/posting";
import type { JournalLineInput } from "@/modules/ledger/rules";
import { manualJournals } from "@/modules/manual-journals/schema";

// Test support only. The database keeps a journal only with the document it was posted for
// (drizzle/0018_sales_invoices.sql). Tests of the ledger and the reports post journals of their
// own; these helpers give each one a manual journal document, in the same transaction, the way
// the app's own command does. The journal is posted first, so the posting engine's own
// refusals come out exactly as they would without the document.

type Who = { userId: string; tenantId: string };
export type BackedSource = { id?: string; date: string; branchId?: string | null; memo?: string; documentNumber?: string };

const AMOUNT = 4;

// One block of SQL that writes a manual journal, its lines and its posting. It reads everything
// from one JSON value, quoted with a tag that the value is checked not to contain.
const WRITE_DOCUMENT = [
  "do $block$",
  "declare p jsonb := $value$%PAYLOAD%$value$::jsonb;",
  "begin",
  "  insert into public.manual_journals (id, tenant_id, journal_date, memo, branch_id, created_by, updated_by)",
  "    values ((p->>'id')::uuid, (p->>'tenant')::uuid, (p->>'date')::date, p->>'memo', (p->>'branch')::uuid, (p->>'user')::uuid, (p->>'user')::uuid);",
  "  insert into public.manual_journal_lines (tenant_id, manual_journal_id, line_no, account_id, description, debit, credit, created_by)",
  "    select (p->>'tenant')::uuid, (p->>'id')::uuid, (l->>'n')::int, (l->>'account')::uuid, l->>'description', (l->>'debit')::numeric, (l->>'credit')::numeric, (p->>'user')::uuid",
  "    from jsonb_array_elements(p->'lines') l;",
  "  update public.manual_journals",
  "    set status = 'posted', number = p->>'number', journal_id = (p->>'journal')::uuid, posted_at = now(), posted_by = (p->>'user')::uuid, updated_at = now(), updated_by = (p->>'user')::uuid",
  "    where tenant_id = (p->>'tenant')::uuid and id = (p->>'id')::uuid;",
  "end $block$",
].join("\n");

/** Posts one manual-journal source through the engine and writes the manual journal it belongs to. Returns the journal's id. */
export async function postBacked(tx: Tx, who: Who, source: BackedSource, lines: readonly JournalLineInput[]): Promise<string> {
  const id = source.id ?? randomUUID();
  // A number of the right shape that no series hands out, unless the test gives its own.
  const number = source.documentNumber ?? `JV-0000-${String(randomInt(1_000_000_000, 9_999_999_999))}`;
  const journalId = await postJournal(tx, { type: "manual_journal", id, date: source.date, branchId: source.branchId, memo: source.memo, documentNumber: number }, lines);
  // The document, its lines and its posting in one round trip: a test may post a thousand of these.
  const payload = JSON.stringify({
    id,
    tenant: who.tenantId,
    user: who.userId,
    date: source.date,
    memo: source.memo?.trim() || "Test journal",
    branch: source.branchId ?? null,
    number,
    journal: journalId,
    lines: lines.map((line, index) => ({ n: index + 1, account: line.accountId, description: line.description ?? null, debit: (line.debit ?? null)?.toFixed(AMOUNT) ?? "0", credit: (line.credit ?? null)?.toFixed(AMOUNT) ?? "0" })),
  });
  if (payload.includes("$value$") || payload.includes("$block$")) throw new Error("postBacked: a test value holds a dollar-quote tag");
  await tx.execute(sql.raw(WRITE_DOCUMENT.replace("%PAYLOAD%", () => payload)));
  return journalId;
}

/** Reverses a journal posted with postBacked and marks its manual journal reversed. Returns the reversal's id. */
export async function reverseBacked(tx: Tx, who: Who, journalId: string, reversal: { date: string; memo?: string | null }): Promise<string> {
  const reversalJournalId = await reverseJournal(tx, journalId, reversal);
  await tx
    .update(manualJournals)
    .set({ status: "reversed", reversalJournalId, reversedAt: sql`now()`, reversedBy: who.userId, updatedAt: sql`now()`, updatedBy: who.userId })
    .where(and(eq(manualJournals.tenantId, who.tenantId), eq(manualJournals.journalId, journalId)));
  return reversalJournalId;
}
