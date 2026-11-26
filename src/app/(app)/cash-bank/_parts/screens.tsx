import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { getExpense, getExpenseChoices, getTransfer, listCashBankAccounts, listExpenses, listTransfers, type JournalLine } from "@/modules/cash-bank/queries";
import { formatIsoDate } from "@/modules/currencies/rules";
import { can } from "@/modules/tenant/rules";
import { ReceiptsCard } from "../../daily-expenses/_parts/receipts";
import { addAccountAction, archiveAccountAction, bankDetailsAction, cancelExpenseAction, cancelTransferAction, expenseAction, transferAction } from "./actions";

type Session = Awaited<ReturnType<typeof requireTenant>>;
const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const EXPENSE_ROWS = 5;

/** Why this member cannot open the cash and bank screens, or null. */
export const closed = (session: Session) =>
  !session.modules.cash_bank ? "Cash and bank is switched off for this company." : !can(session.role, "cash_bank.read") ? "Your role does not include cash and bank." : null;

export function Shut({ title, why }: { title: string; why: string }) {
  return (
    <>
      <PageHead title={title} />
      <p className="text-muted-foreground">{why}</p>
    </>
  );
}

export function CashNav({ here }: { here: "accounts" | "transfers" | "expenses" | "reconcile" }) {
  const tab = (key: typeof here, href: string, label: string) => (
    <Link
      href={href}
      aria-current={key === here ? "page" : undefined}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${key === here ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Cash and bank" className="mb-4 flex flex-wrap gap-1">
      {tab("accounts", "/cash-bank", "Accounts")}
      {tab("transfers", "/cash-bank/transfers", "Transfers")}
      {tab("expenses", "/cash-bank/expenses", "Expenses")}
      {tab("reconcile", "/cash-bank/reconcile", "Reconcile")}
    </nav>
  );
}

const Status = ({ status }: { status: "posted" | "cancelled" }) => (
  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${status === "posted" ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground"}`}>{status === "posted" ? "Posted" : "Cancelled"}</span>
);

function Books({ title, lines }: { title: string; lines: JournalLine[] }) {
  if (lines.length === 0) return null;
  return (
    <Card title={title}>
      <table aria-label={title} className="w-full max-w-3xl text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Account</th>
            <th className="py-2 pr-4 font-medium">What</th>
            <th className="py-2 pr-4 text-right font-medium">Debit</th>
            <th className="py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((line, index) => (
            <tr key={index}>
              <td className="py-2 pr-4">{line.account}</td>
              <td className="py-2 pr-4 text-muted-foreground">{line.description}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{line.debit.isZero() ? "" : formatAmount(line.debit)}</td>
              <td className="py-2 text-right tabular-nums">{line.credit.isZero() ? "" : formatAmount(line.credit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CancelCard({ action, word }: { action: Parameters<typeof ActionForm>[0]["action"]; word: string }) {
  return (
    <Card title={`Cancel this ${word}`}>
      <p className="mb-3 text-sm text-muted-foreground">A {word} entered by mistake is taken back with a reversal on the day you choose. It is never changed or removed.</p>
      <ActionForm action={action} submitLabel={`Cancel ${word}`}>
        <div className="grid max-w-2xl gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <Field label="Cancelled on" name="date" type="date" defaultValue={todayIso(new Date())} required />
          <Field label="Why" name="reason" maxLength={300} autoComplete="off" required />
        </div>
      </ActionForm>
    </Card>
  );
}

// ── Accounts ────────────────────────────────────────────────────────────────────────────────────

export async function AccountsScreen() {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Cash and bank" why={why} />;
  const manager = can(session.role, "cash_bank.manage");
  const rows = await listCashBankAccounts(session);
  return (
    <>
      <PageHead title="Cash and bank" sub="The company's cash and bank accounts and what each holds: everything ever posted to it. Petty cash is one more cash account." />
      <CashNav here="accounts" />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          {rows.length === 0 ? (
            <Empty>No cash or bank account yet.</Empty>
          ) : (
            <table aria-label="Cash and bank accounts" className="w-full min-w-[620px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Account</th>
                  <th className="py-2 pr-4 font-medium">Bank and number</th>
                  <th className="py-2 pr-4 text-right font-medium">Holds</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id} className={row.archived ? "text-muted-foreground" : undefined}>
                    <td className="py-2 pr-4">
                      <Link href={`/reports/ledger?account=${row.id}`} className="underline-offset-4 hover:underline">
                        {row.code} {row.name}
                      </Link>
                      <span className="text-muted-foreground"> ({row.kind === "bank" ? "bank" : "cash"}{row.archived ? ", archived" : ""})</span>
                    </td>
                    <td className="py-2 pr-4">{[row.bankName, row.accountNumber].filter(Boolean).join(", ")}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums" data-testid={`holds-${row.code}`}>
                      {row.balance === null ? "Not shown" : formatAmount(row.balance)}
                    </td>
                    <td className="py-2 text-right">
                      {manager && !row.archived && row.balance !== null && row.balance.isZero() ? <ActionForm action={archiveAccountAction.bind(null, row.id, row.updatedAt)} submitLabel="Archive" compact /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {session.branchIds === null
              ? "An account is archived only when it holds nothing: move what it holds out first."
              : "What each account holds is shown to those who work in every branch: you do not see every posting to it."}
          </p>
        </Card>
        {manager ? (
          <Card title="Add an account">
            <ActionForm action={addAccountAction} submitLabel="Add account">
              <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kind">Kind</Label>
                  <select id="kind" name="kind" className={SELECT} defaultValue="bank">
                    <option value="bank">Bank account</option>
                    <option value="cash">Cash account</option>
                  </select>
                </div>
                <Field label="Name" name="name" maxLength={120} autoComplete="off" required hint="Such as HBL current account, or Petty cash." />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Bank (a bank account only)" name="bankName" maxLength={80} autoComplete="off" />
                <Field label="Account number or IBAN" name="accountNumber" maxLength={34} autoComplete="off" />
              </div>
            </ActionForm>
          </Card>
        ) : null}
        {manager
          ? rows
              .filter((row) => row.kind === "bank" && !row.archived)
              .map((row) => (
                <Card key={row.id} title={`${row.name}: bank and number`}>
                  <ActionForm action={bankDetailsAction.bind(null, row.id)} submitLabel="Save">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Bank" name="bankName" id={`bank-${row.id}`} defaultValue={row.bankName ?? ""} maxLength={80} autoComplete="off" />
                      <Field label="Account number or IBAN" name="accountNumber" id={`number-${row.id}`} defaultValue={row.accountNumber ?? ""} maxLength={34} autoComplete="off" />
                    </div>
                  </ActionForm>
                </Card>
              ))
          : null}
      </div>
    </>
  );
}

// ── Transfers ───────────────────────────────────────────────────────────────────────────────────

export async function TransfersScreen() {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Transfers" why={why} />;
  // Money is moved between the company's accounts by someone who works in every branch.
  const manager = can(session.role, "cash_bank.manage") && session.branchIds === null;
  const [rows, accounts] = await Promise.all([listTransfers(session), listCashBankAccounts(session)]);
  const usable = accounts.filter((a) => !a.archived);
  return (
    <>
      <PageHead title="Transfers" sub="Money moved from one of the company's cash or bank accounts to another: cash banked, cash drawn, petty cash topped up." />
      <CashNav here="transfers" />
      <div className="flex max-w-5xl flex-col gap-5">
        {manager ? (
          <Card title="Move money">
            <ActionForm action={transferAction} submitLabel="Record transfer">
              {/* One key for this transfer, however many times it is sent: it is recorded once. */}
              <input type="hidden" name="clientKey" value={randomUUID()} />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="fromId">From</Label>
                  <select id="fromId" name="fromId" className={SELECT} required>
                    <option value="">Choose</option>
                    {usable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="toId">To</Label>
                  <select id="toId" name="toId" className={SELECT} required>
                    <option value="">Choose</option>
                    {usable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-[10rem_10rem_minmax(0,1fr)]">
                <Field label="Date" name="date" type="date" defaultValue={todayIso(new Date())} required />
                <Field label="Amount" name="amount" inputMode="decimal" autoComplete="off" required />
                <Field label="Reference (cheque or slip no.)" name="reference" maxLength={60} autoComplete="off" />
              </div>
              <Field label="Note" name="memo" maxLength={300} autoComplete="off" />
            </ActionForm>
          </Card>
        ) : null}
        <Card>
          {rows.length === 0 ? (
            <Empty>No transfers yet.</Empty>
          ) : (
            <table aria-label="Transfers" className="w-full min-w-[620px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">From</th>
                  <th className="py-2 pr-4 font-medium">To</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`/cash-bank/transfers/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.from}</td>
                    <td className="py-2 pr-4">{row.to}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(row.amount)}</td>
                    <td className="py-2">
                      <Status status={row.status} />
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

export async function TransferScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Transfer" why={why} />;
  const transfer = await getTransfer(session, (await params).id);
  if (!transfer) notFound();
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/cash-bank/transfers" className="text-muted-foreground underline-offset-4 hover:underline">
          Transfers
        </Link>
      </p>
      <PageHead title={transfer.number} sub={`${formatAmount(transfer.amount)} from ${transfer.from} to ${transfer.to}, ${formatIsoDate(transfer.date)}.`} />
      <div className="flex max-w-5xl flex-col gap-5">
        <p className="text-sm" data-testid="document-status">
          <Status status={transfer.status} />
          {transfer.reference ? ` Reference ${transfer.reference}.` : ""}
          {transfer.memo ? ` ${transfer.memo}` : ""}
          {transfer.cancelReason ? ` Cancelled: ${transfer.cancelReason}.` : ""}
        </p>
        <Books title="In the books" lines={transfer.journal} />
        <Books title="Taken back" lines={transfer.reversal} />
        {transfer.status === "posted" && can(session.role, "cash_bank.manage") ? <CancelCard action={cancelTransferAction.bind(null, transfer.id)} word="transfer" /> : null}
      </div>
    </>
  );
}

// ── Expenses ────────────────────────────────────────────────────────────────────────────────────

export async function ExpensesScreen() {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Expenses" why={why} />;
  const rows = await listExpenses(session);
  return (
    <>
      <PageHead title="Expenses" sub="Money spent out of a cash or bank account: what it was for, who was paid, and any tax withheld." />
      <CashNav here="expenses" />
      <Card className="max-w-5xl">
        {can(session.role, "cash_bank.manage") ? (
          <div className="mb-3 flex">
            <Link href="/cash-bank/expenses/new" className={buttonVariants({ className: "ml-auto" })}>
              New expense
            </Link>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <Empty>No expenses yet.</Empty>
        ) : (
          <table aria-label="Expenses" className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Number</th>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Paid to</th>
                <th className="py-2 pr-4 font-medium">From</th>
                <th className="py-2 pr-4 text-right font-medium">Total</th>
                <th className="py-2 pr-4 text-right font-medium">Paid</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-2 pr-4 font-medium">
                    <Link href={`/cash-bank/expenses/${row.id}`} className="underline-offset-4 hover:underline">
                      {row.number}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                  <td className="py-2 pr-4">{row.paidTo}</td>
                  <td className="py-2 pr-4">{row.from}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(row.total)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(row.paid)}</td>
                  <td className="py-2">
                    <Status status={row.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

export async function NewExpenseScreen() {
  const session = await requireTenant();
  const why = closed(session) ?? (can(session.role, "cash_bank.manage") ? null : "Only the owner or an accountant spends the company's money.");
  if (why) return <Shut title="New expense" why={why} />;
  const today = todayIso(new Date());
  const choices = await getExpenseChoices(session, today);
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/cash-bank/expenses" className="text-muted-foreground underline-offset-4 hover:underline">
          Expenses
        </Link>
      </p>
      <PageHead title="New expense" sub="Recorded and in the books at once. The province's tax on services is added to the lines and withheld whole; income tax is withheld at the supplier's rate." />
      <Card className="max-w-5xl">
        <ActionForm action={expenseAction} submitLabel="Record expense">
          {/* One key for this expense, however many times it is sent: it is recorded once. */}
          <input type="hidden" name="clientKey" value={randomUUID()} />
          <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="Date" name="date" type="date" defaultValue={today} required />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="accountId">Paid from</Label>
              <select id="accountId" name="accountId" className={SELECT} required>
                <option value="">Choose</option>
                {choices.moneyAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <Field label="Reference (bill or slip no.)" name="reference" maxLength={60} autoComplete="off" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="supplierId">Supplier</Label>
              <select id="supplierId" name="supplierId" className={SELECT}>
                <option value="">Not a supplier on the list</option>
                {choices.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.onActiveList ? " (on the Active Taxpayers List)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <Field label="Or paid to (name)" name="payee" maxLength={120} autoComplete="off" hint="For someone who is not a supplier on the list. Tax is withheld only from a supplier." />
          </div>
          {choices.withholds ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provincialTaxCode">Province&apos;s tax on services</Label>
                <select id="provincialTaxCode" name="provincialTaxCode" className={SELECT}>
                  <option value="">None</option>
                  {choices.provincialLines.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label} ({l.rate.toFixed()}%)
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="incomeTaxCode">Income tax withheld</Label>
                <select id="incomeTaxCode" name="incomeTaxCode" className={SELECT}>
                  <option value="">None</option>
                  {choices.incomeTaxLines.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label} ({l.rule.rate.toFixed()}%{l.rule.rateNonAtl ? `, ${l.rule.rateNonAtl.toFixed()}% not on the list` : ""})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This company does not withhold tax from what it pays (Purchases, settings).</p>
          )}
          {choices.branches.length > 1 || session.branchIds !== null ? (
            <div className="flex max-w-xs flex-col gap-1.5">
              <Label htmlFor="branchId">Branch</Label>
              <select id="branchId" name="branchId" className={SELECT}>
                {session.branchIds === null ? <option value="">The whole company</option> : null}
                {choices.branches
                  .filter((b) => session.branchIds === null || session.branchIds.includes(b.id))
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </select>
            </div>
          ) : null}
          <table aria-label="Lines" className="w-full min-w-[620px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="w-64 py-2 pr-2 font-medium">Charged to</th>
                <th className="py-2 pr-2 font-medium">What it was for</th>
                <th className="w-36 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: EXPENSE_ROWS }, (_, index) => (
                <tr key={index}>
                  <td className="py-1 pr-2">
                    <select name="lineAccountId" aria-label={`Account, line ${index + 1}`} className={SELECT} defaultValue="">
                      <option value="" />
                      {choices.expenseAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    <input name="lineDescription" aria-label={`What it was for, line ${index + 1}`} maxLength={200} autoComplete="off" className={SELECT} />
                  </td>
                  <td className="py-1">
                    <input name="lineAmount" aria-label={`Amount, line ${index + 1}`} inputMode="decimal" autoComplete="off" className={`${SELECT} text-right tabular-nums`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Field label="Note" name="memo" maxLength={300} autoComplete="off" />
        </ActionForm>
      </Card>
    </>
  );
}

export async function ExpenseScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Expense" why={why} />;
  const expense = await getExpense(session, (await params).id);
  if (!expense) notFound();
  // Opened from Daily expenses, it leads back there.
  const fromDaily = (await searchParams)?.from === "daily";
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={fromDaily ? "/daily-expenses" : "/cash-bank/expenses"} className="text-muted-foreground underline-offset-4 hover:underline">
          {fromDaily ? "Daily expenses" : "Expenses"}
        </Link>
      </p>
      <PageHead title={expense.number} sub={`${expense.paidTo ? `Paid to ${expense.paidTo} from` : "Paid from"} ${expense.from}, ${formatIsoDate(expense.date)}${expense.branch ? `, ${expense.branch}` : ""}.`} />
      <div className="flex max-w-5xl flex-col gap-5">
        <p className="text-sm" data-testid="document-status">
          <Status status={expense.status} />
          {expense.reference ? ` Reference ${expense.reference}.` : ""}
          {expense.memo ? ` ${expense.memo}` : ""}
          {expense.cancelReason ? ` Cancelled: ${expense.cancelReason}.` : ""}
        </p>
        <Card>
          <table aria-label="Expense lines" className="w-full max-w-3xl text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Charged to</th>
                <th className="py-2 pr-4 font-medium">What it was for</th>
                <th className="py-2 pr-4 text-right font-medium">Amount</th>
                <th className="py-2 text-right font-medium">Province&apos;s tax</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {expense.lines.map((line, index) => (
                <tr key={index}>
                  <td className="py-2 pr-4">{line.account}</td>
                  <td className="py-2 pr-4">{line.description}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(line.amount)}</td>
                  <td className="py-2 text-right tabular-nums">{line.provincialShare.isZero() ? "" : formatAmount(line.provincialShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="mt-4 grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm" data-testid="expense-figures">
            <dt>Lines</dt>
            <dd className="text-right tabular-nums">{formatAmount(expense.amount)}</dd>
            <dt>Province&apos;s tax on services</dt>
            <dd className="text-right tabular-nums">{formatAmount(expense.provincialTax)}</dd>
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold tabular-nums">{formatAmount(expense.total)}</dd>
            <dt>Withheld</dt>
            <dd className="text-right tabular-nums">{formatAmount(expense.withheld)}</dd>
            <dt className="font-semibold">Paid</dt>
            <dd className="text-right font-semibold tabular-nums">{formatAmount(expense.paid)}</dd>
          </dl>
        </Card>
        {expense.withholdings.length > 0 ? (
          <Card title="Tax withheld">
            <ul className="divide-y text-sm">
              {expense.withholdings.map((w) => (
                <li key={w.kind} className="py-2">
                  {w.kind === "income_tax" ? "Income tax" : "Province's tax on services"}: {formatAmount(w.amount)}, {w.rate.toFixed()}% of {formatAmount(w.base)}
                  {w.kind === "income_tax" ? (w.onActiveList ? ", the supplier on the Active Taxpayers List" : ", the supplier not on the Active Taxpayers List") : ""}.
                  <span className="block text-xs text-muted-foreground">{w.legalReference}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <ReceiptsCard session={session} expenseId={expense.id} />
        <Books title="In the books" lines={expense.journal} />
        <Books title="Taken back" lines={expense.reversal} />
        {expense.status === "posted" && can(session.role, "cash_bank.manage") ? <CancelCard action={cancelExpenseAction.bind(null, expense.id)} word="expense" /> : null}
      </div>
    </>
  );
}
