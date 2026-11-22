import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import {
  getReconciliationPage,
  listBankAccounts,
} from "@/modules/bank-reconciliation/queries";
import { LAYOUT_LABELS, LAYOUTS } from "@/modules/bank-reconciliation/rules";
import { formatIsoDate } from "@/modules/currencies/rules";
import { can } from "@/modules/tenant/rules";
import {
  deleteStatementAction,
  importStatementAction,
  matchAutomaticallyAction,
  matchByHandAction,
  unmatchAction,
} from "./reconcile-actions";
import { CashNav, closed, Shut } from "./screens";

// Step 35: reconciling a bank account with the bank's statements.

const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const INPUT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const RULES: Record<string, string> = {
  reference: "Named in the statement",
  amount_date: "Same amount, days apart",
  by_hand: "By hand",
};

function wide(
  session: Awaited<ReturnType<typeof requireTenant>>,
): string | null {
  return session.branchIds === null
    ? null
    : "A bank account is reconciled by someone who works across the whole company.";
}

export async function ReconcileListScreen() {
  const session = await requireTenant();
  const why = closed(session) ?? wide(session);
  if (why) return <Shut title="Reconcile" why={why} />;
  const accounts = await listBankAccounts(session);
  return (
    <>
      <PageHead
        title="Reconcile"
        sub="Each bank account's statements from the bank, matched with the books."
      />
      <CashNav here="reconcile" />
      <Card className="max-w-3xl">
        {accounts.length === 0 ? (
          <Empty>No bank account yet. Add one under Accounts.</Empty>
        ) : (
          <ul className="divide-y text-sm" aria-label="Bank accounts">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <Link
                  href={`/cash-bank/reconcile/${a.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {a.label}
                </Link>
                <span className="text-muted-foreground">
                  {a.lastStatement
                    ? `Statements to ${formatIsoDate(a.lastStatement)}`
                    : "No statement yet"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Figure({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-4 py-1 text-sm ${strong ? "font-semibold" : ""}`}
    >
      <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** The lines still to match: the statement's and the books', with boxes to tick for whoever keeps the account. */
function MatchTables({
  page,
  keep,
}: {
  page: NonNullable<Awaited<ReturnType<typeof getReconciliationPage>>>;
  keep: boolean;
}) {
  return (
    <>
      {keep ? (
        <p className="mb-2 text-sm text-muted-foreground">
          Tick lines from the statement and entries from the books that are the
          same money: their totals must be equal.
        </p>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="overflow-x-auto">
          <h3 className="mb-1 text-sm font-semibold">
            On the statement, not in the books
          </h3>
          <table
            aria-label="Statement lines to match"
            className="w-full text-left text-sm"
          >
            <tbody className="divide-y">
              {page.bankLines.map((line) => (
                <tr key={line.id}>
                  <td className="py-1.5 pr-2">
                    {keep ? (
                      <input
                        type="checkbox"
                        name="bank"
                        value={line.id}
                        aria-label={`Statement ${line.date} ${line.description}`}
                      />
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    {formatIsoDate(line.date)}
                  </td>
                  <td className="py-1.5 pr-2">
                    {line.description}
                    {line.reference ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {line.reference}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatAmount(line.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto">
          <h3 className="mb-1 text-sm font-semibold">
            In the books, not on a statement
          </h3>
          <table
            aria-label="Entries to match"
            className="w-full text-left text-sm"
          >
            <tbody className="divide-y">
              {page.bookLines.map((line) => (
                <tr key={line.id}>
                  <td className="py-1.5 pr-2">
                    {keep ? (
                      <input
                        type="checkbox"
                        name="book"
                        value={line.id}
                        aria-label={`Entry ${line.date} ${line.documentNumber ?? ""}`}
                      />
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    {formatIsoDate(line.date)}
                  </td>
                  <td className="py-1.5 pr-2">
                    {line.documentNumber ?? ""}
                    {line.chequeNumber ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · cheque {line.chequeNumber}
                      </span>
                    ) : null}
                    {line.description ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {line.description}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatAmount(line.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export async function ReconcileScreen({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ on?: string | string[] }>;
}) {
  const session = await requireTenant();
  const why = closed(session) ?? wide(session);
  if (why) return <Shut title="Reconcile" why={why} />;
  const [{ accountId }, query] = await Promise.all([params, searchParams]);
  const on =
    typeof query.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.on)
      ? query.on
      : undefined;
  const page = await getReconciliationPage(session, accountId, on);
  if (!page) notFound();
  const keep = can(session.role, "cash_bank.manage");
  const r = page.reconciliation;
  return (
    <>
      <PageHead
        title={`Reconcile ${page.account.code} ${page.account.name}`}
        sub="What the bank says, matched with what the books say."
      />
      <CashNav here="reconcile" />
      <div className="flex max-w-6xl flex-col gap-5">
        {r ? (
          <Card title={`On ${formatIsoDate(r.asAt)}`}>
            <dl aria-label="Reconciliation" className="divide-y">
              <Figure
                label="Balance per bank"
                value={formatAmount(r.bankBalance)}
              />
              <Figure
                label="Balance per books"
                value={formatAmount(r.bookBalance)}
              />
              <Figure
                label="Less: entries in the books the bank has not shown yet"
                value={formatAmount(r.unmatchedBooks)}
              />
              <Figure
                label="Add: lines on the statement not in the books yet"
                value={formatAmount(r.unmatchedBank)}
              />
              <Figure
                label="Books, reconciled"
                value={formatAmount(r.adjustedBooks)}
                strong
              />
              <Figure
                label="Difference"
                value={formatAmount(r.difference)}
                strong
              />
            </dl>
            <p
              className="mt-3 text-sm text-muted-foreground"
              data-testid="reconcile-verdict"
            >
              {r.difference.isZero()
                ? "Reconciled: the books, with what is still to come through, equal the bank."
                : `The books and the bank differ by ${formatAmount(r.difference.abs())}. ${
                    !r.missingFromStatements.isZero()
                      ? `The bank's balance is ${formatAmount(r.missingFromStatements.abs())} ${r.missingFromStatements.isNegative() ? "less" : "more"} than the lines imported add up to: a statement is missing, or a line was lost. Import the missing statement.`
                      : "Match the rest (a cheque written before the first statement and presented after it is matched too), or put what is missing in the books."
                  }`}
              {r.openingFromBooks
                ? " The first statement does not say what the account held before it; the books' figure is taken."
                : ""}
              {r.bankBalanceGiven
                ? ""
                : " The bank's files give no running balance, so the bank's figure is its lines added up: a missing statement would not show."}
            </p>
            <form method="get" className="mt-3 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="on">On another day</Label>
                <input
                  id="on"
                  name="on"
                  type="date"
                  defaultValue={r.asAt}
                  className={INPUT}
                />
              </div>
              <button
                type="submit"
                className="h-8 rounded-lg border px-3 text-sm"
              >
                Show
              </button>
            </form>
          </Card>
        ) : null}

        {keep ? (
          <Card title="Import a statement">
            <p className="mb-3 text-sm text-muted-foreground">
              The CSV or Excel (.xlsx) file the bank&apos;s internet banking
              gives. Lines imported before are not imported again; if anything in
              the file is wrong, nothing is imported and every wrong row is
              listed. An older Excel file (.xls): save it as .xlsx first.
            </p>
            <ActionForm
              action={importStatementAction.bind(null, page.account.id)}
              submitLabel="Import"
              maxUploadBytes={2 * 1024 * 1024}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="file">CSV or Excel file</Label>
                  <input
                    id="file"
                    name="file"
                    type="file"
                    accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    required
                    className="text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="layout">The bank</Label>
                  <select
                    id="layout"
                    name="layout"
                    defaultValue="auto"
                    className={SELECT}
                  >
                    {LAYOUTS.map((layout) => (
                      <option key={layout} value={layout}>
                        {LAYOUT_LABELS[layout]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Name the columns yourself (choose that above)
                </summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["date", "Day"],
                      ["description", "Description"],
                      ["reference", "Cheque or reference"],
                      ["out", "Money out (debit)"],
                      ["in", "Money in (credit)"],
                      ["amount", "Or one amount column"],
                      ["balance", "Balance"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="flex flex-col gap-1.5">
                      <Label htmlFor={`column_${key}`}>{label}</Label>
                      <input
                        id={`column_${key}`}
                        name={`column_${key}`}
                        placeholder="Heading in the file"
                        className={INPUT}
                      />
                    </div>
                  ))}
                </div>
              </details>
            </ActionForm>
          </Card>
        ) : null}

        {page.statements.length > 0 ? (
          <Card title="To match">
            {keep ? (
              <div className="mb-3">
                <ActionForm
                  action={matchAutomaticallyAction.bind(null, page.account.id)}
                  submitLabel="Match what is sure"
                  compact
                />
              </div>
            ) : null}
            {page.bankLines.length === 0 && page.bookLines.length === 0 ? (
              <Empty>Everything is matched.</Empty>
            ) : keep ? (
              <ActionForm
                action={matchByHandAction.bind(null, page.account.id)}
                submitLabel="Match the lines ticked"
              >
                <MatchTables page={page} keep />
              </ActionForm>
            ) : (
              <MatchTables page={page} keep={false} />
            )}
          </Card>
        ) : null}

        {page.matches.length > 0 ? (
          <Card title="Matched lately">
            <ul className="divide-y text-sm" aria-label="Matches">
              {page.matches.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-start justify-between gap-3 py-2"
                >
                  <div>
                    <p className="font-medium tabular-nums">
                      {formatAmount(m.amount)}{" "}
                      <span className="font-normal text-muted-foreground">
                        · {RULES[m.rule] ?? m.rule}
                      </span>
                    </p>
                    <p className="text-muted-foreground">
                      {m.bank
                        .map((b) => `${formatIsoDate(b.date)} ${b.description}`)
                        .join("; ")}
                      {m.bank.length > 0 && m.books.length > 0 ? " ↔ " : ""}
                      {m.books
                        .map(
                          (b) => `${formatIsoDate(b.date)} ${b.number ?? ""}`,
                        )
                        .join("; ")}
                    </p>
                  </div>
                  {keep ? (
                    <ActionForm
                      action={unmatchAction.bind(null, m.id)}
                      submitLabel="Unmatch"
                      compact
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card title="Statements imported">
          {page.statements.length === 0 ? (
            <Empty>No statement yet.</Empty>
          ) : (
            <table aria-label="Statements" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">File</th>
                  <th className="py-2 pr-3 font-medium">Days</th>
                  <th className="py-2 pr-3 text-right font-medium">
                    Lines new
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">Matched</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {page.statements.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3">
                      {s.fileName}
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(new Date(s.importedAt))}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {formatIsoDate(s.from)} to {formatIsoDate(s.to)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {s.added} of {s.lines}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {s.matched}
                    </td>
                    <td className="py-2 text-right">
                      {keep && s.matched === 0 ? (
                        <ActionForm
                          action={deleteStatementAction.bind(null, s.id)}
                          submitLabel="Remove"
                          compact
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
