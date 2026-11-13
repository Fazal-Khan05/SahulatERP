import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { AMOUNT_SCALE, formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listAccounts } from "@/modules/ledger/queries";
import { JOURNAL_SOURCES, visibleAccounts } from "@/modules/ledger/rules";
import { getManualJournal, listManualJournals, postProblem, type ManualJournal } from "@/modules/manual-journals/queries";
import { STATUS_LABELS, draftTotals, type ManualJournalStatus } from "@/modules/manual-journals/rules";
import { getCompanySetup } from "@/modules/setup/queries";
import { listBranches } from "@/modules/tenant/queries";
import { can, seesBranch } from "@/modules/tenant/rules";
import { discardJournalAction, reverseJournalAction, saveJournalAction } from "./actions";
import { JournalForm } from "./journal-form";

const NO_ACCESS = "Only an owner, an accountant or an auditor can see journals.";

function StatusPill({ status, testId }: { status: ManualJournalStatus; testId?: string }) {
  const tone = status === "posted" ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground";
  return (
    <span data-testid={testId} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export async function JournalsScreen() {
  const session = await requireTenant();
  if (!can(session.role, "journal.read")) {
    return (
      <>
        <PageHead title="Journals" />
        <p className="text-muted-foreground">{NO_ACCESS}</p>
      </>
    );
  }
  const { rows, more } = await listManualJournals(session);
  return (
    <>
      <PageHead title="Journals" sub="Entries made by hand, such as depreciation, a correction, or the owner's money put in or taken out." />
      {can(session.role, "journal.manage") ? (
        <p className="mb-4">
          <Link href="/journals/new" className={buttonVariants()}>
            New journal
          </Link>
        </p>
      ) : null}
      <Card className="max-w-4xl">
        {rows.length === 0 ? (
          <Empty>No journals yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Journals" className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">What it is for</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/journals/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.memo}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(row.total)}</td>
                    <td className="py-2">
                      <StatusPill status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 journals.</p> : null}
      </Card>
    </>
  );
}

/**
 * What the entry form needs: the accounts a manual journal may use, and the branches this member
 * may choose. `keep` are accounts already on the draft: one that is no longer offered (archived
 * since, say) stays in the list, marked, so the line shows what it is and saving says why.
 */
async function formChoices(session: Awaited<ReturnType<typeof requireTenant>>, keep: readonly { accountId: string; accountCode: string; accountName: string }[] = []) {
  const [chart, setup, branches] = await Promise.all([listAccounts(session), getCompanySetup(session), listBranches(session)]);
  const blocked: readonly string[] = JOURNAL_SOURCES.manual_journal.blockedControls;
  const offered = visibleAccounts(chart, setup?.salesTaxRegistered ?? true)
    .filter((account) => !account.isGroup && account.archivedAt === null && !blocked.includes(account.controlType ?? ""))
    .map((account) => ({ id: account.id, label: `${account.code} ${account.name}` }));
  const kept = keep
    .filter((line, index) => !offered.some((account) => account.id === line.accountId) && keep.findIndex((other) => other.accountId === line.accountId) === index)
    .map((line) => ({ id: line.accountId, label: `${line.accountCode} ${line.accountName} (no longer offered)` }));
  return {
    accounts: [...offered, ...kept],
    branches: branches.filter((branch) => seesBranch(session.branchIds, branch.id)).map((branch) => ({ id: branch.id, name: branch.name })),
    mustChooseBranch: session.branchIds !== null,
    hasChart: chart.length > 0,
  };
}

function NoChart() {
  return (
    <p className="text-muted-foreground">
      This company has no chart of accounts yet. It is created when the company is set up, or under{" "}
      <Link href="/settings/accounts" className="font-medium text-foreground underline underline-offset-4">
        Settings, Accounts
      </Link>
      .
    </p>
  );
}

export async function NewJournalScreen() {
  const session = await requireTenant();
  if (!can(session.role, "journal.manage")) {
    return (
      <>
        <PageHead title="New journal" />
        <p className="text-muted-foreground">Only an owner or an accountant can write journals.</p>
      </>
    );
  }
  const choices = await formChoices(session);
  return (
    <>
      <PageHead title="New journal" />
      {choices.hasChart ? (
        <Card className="max-w-4xl">
          <JournalForm
            action={saveJournalAction.bind(null, null, "")}
            accounts={choices.accounts}
            branches={choices.branches}
            mustChooseBranch={choices.mustChooseBranch}
            initial={{ date: todayIso(new Date()), memo: "", branchId: "", lines: [] }}
          />
        </Card>
      ) : (
        <NoChart />
      )}
    </>
  );
}

function LinesTable({ journal }: { journal: ManualJournal }) {
  const totals = draftTotals(journal.lines);
  return (
    <div className="overflow-x-auto">
      <table aria-label="Journal lines" className="w-full min-w-[520px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Account</th>
            <th className="py-2 pr-4 font-medium">Description</th>
            <th className="py-2 pr-4 text-right font-medium">Debit</th>
            <th className="py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {journal.lines.map((line) => (
            <tr key={line.lineNo}>
              <td className="py-2 pr-4">
                <span className="font-medium tabular-nums">{line.accountCode}</span> {line.accountName}
              </td>
              <td className="py-2 pr-4">{line.description}</td>
              <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{line.debit.isZero() ? "" : formatAmount(line.debit)}</td>
              <td className="py-2 text-right whitespace-nowrap tabular-nums">{line.credit.isZero() ? "" : formatAmount(line.credit)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t font-bold">
          <tr>
            <td className="py-2 pr-4" colSpan={2}>
              Total
            </td>
            <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(totals.debit)}</td>
            <td className="py-2 text-right whitespace-nowrap tabular-nums">{formatAmount(totals.credit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export async function JournalScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "journal.read")) {
    return (
      <>
        <PageHead title="Journal" />
        <p className="text-muted-foreground">{NO_ACCESS}</p>
      </>
    );
  }
  const [{ id }, { refused }] = await Promise.all([params, searchParams]);
  const journal = await getManualJournal(session, id);
  if (!journal) notFound();
  const manager = can(session.role, "journal.manage");
  const loadedAt = journal.updatedAt.toISOString();
  const back = (
    <p className="mb-2 text-sm">
      <Link href="/journals" className="text-muted-foreground underline-offset-4 hover:underline">
        Journals
      </Link>
    </p>
  );

  if (journal.status === "draft" && manager) {
    const [choices, problem] = await Promise.all([formChoices(session, journal.lines), typeof refused === "string" && refused !== "" ? postProblem(session, journal.id) : null]);
    return (
      <>
        {back}
        <PageHead title="Draft journal" sub="Not in the books yet. It gets its number when it is posted." />
        <div className="flex max-w-4xl flex-col gap-5">
          <Card>
            <JournalForm
              action={saveJournalAction.bind(null, journal.id, loadedAt)}
              accounts={choices.accounts}
              branches={choices.branches}
              mustChooseBranch={choices.mustChooseBranch}
              initial={{
                date: journal.date,
                memo: journal.memo,
                branchId: journal.branchId ?? "",
                lines: journal.lines.map((line) => ({
                  accountId: line.accountId,
                  description: line.description ?? "",
                  debit: line.debit.isZero() ? "" : line.debit.toFixed(AMOUNT_SCALE).replace(/\.?0+$/, ""),
                  credit: line.credit.isZero() ? "" : line.credit.toFixed(AMOUNT_SCALE).replace(/\.?0+$/, ""),
                })),
              }}
              refused={typeof refused === "string" && refused !== "" ? `Saved as a draft, but not posted. ${problem ?? "Post it again to see why."}` : undefined}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardJournalAction.bind(null, journal.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      {back}
      <PageHead title={journal.number ?? "Draft journal"} sub={journal.memo} />
      <div className="flex max-w-4xl flex-col gap-5">
        <Card>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Date</dt>
            <dd>{formatIsoDate(journal.date)}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <StatusPill status={journal.status} testId="journal-status" />
              {journal.status === "reversed" ? <span className="text-muted-foreground"> Both the journal and its reversal stay in the books.</span> : null}
            </dd>
          </dl>
          <LinesTable journal={journal} />
        </Card>
        {journal.status === "posted" && manager ? (
          <Card title="Reverse this journal">
            <p className="mb-3 text-sm text-muted-foreground">
              A posted journal is never changed or deleted. Reversing it posts a second journal with every debit and credit swapped,
              on the date you choose.
            </p>
            <ActionForm action={reverseJournalAction.bind(null, journal.id, loadedAt)} submitLabel="Reverse journal">
              <Field label="Date of the reversal" name="date" type="date" defaultValue={todayIso(new Date()) < journal.date ? journal.date : todayIso(new Date())} min={journal.date} required className="max-w-[12rem]" />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}
