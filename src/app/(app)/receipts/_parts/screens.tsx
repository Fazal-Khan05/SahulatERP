import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant, type TenantSession } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { AMOUNT_SCALE, formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { findCustomers, getCustomerStanding, getReceipt, listCheques, listMoneyAccounts, listOpenItems, listReceipts, type Receipt, type ReceiptRow } from "@/modules/receipts/queries";
import { METHOD_LABELS, STAGE_LABELS, STATUS_LABELS, type OpenItem, type ReceiptStatus } from "@/modules/receipts/rules";
import { listBranches } from "@/modules/tenant/queries";
import { can, seesBranch } from "@/modules/tenant/rules";
import { applyAdvanceAction, bounceChequeAction, cancelReceiptAction, clearChequeAction, depositChequeAction, discardReceiptAction, saveReceiptAction } from "./actions";
import { ReceiptForm, type OpenRow } from "./receipt-form";

const NO_ACCESS = "Your role does not include receipts.";
const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

function StatusPill({ status, testId }: { status: ReceiptStatus; testId?: string }) {
  const tone = status === "posted" ? "bg-accent text-accent-foreground" : status === "draft" ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive";
  return (
    <span data-testid={testId} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function Refused({ title }: { title: string }) {
  return (
    <>
      <PageHead title={title} />
      <p className="text-muted-foreground">{NO_ACCESS}</p>
    </>
  );
}

/** The two receipts screens, as a row of links above each of them. */
function Sections({ current }: { current: "/receipts" | "/receipts/cheques" }) {
  const sections = [
    { href: "/receipts", label: "Receipts" },
    { href: "/receipts/cheques", label: "Cheques" },
  ] as const;
  return (
    <nav aria-label="Receipts" className="mb-4 flex flex-wrap gap-x-5 gap-y-1 border-b pb-2 text-sm">
      {sections.map((section) =>
        section.href === current ? (
          <span key={section.href} aria-current="page" className="font-semibold">
            {section.label}
          </span>
        ) : (
          <Link key={section.href} href={section.href} className="text-muted-foreground underline-offset-4 hover:underline">
            {section.label}
          </Link>
        ),
      )}
    </nav>
  );
}

function Back() {
  return (
    <p className="mb-2 text-sm">
      <Link href="/receipts" className="text-muted-foreground underline-offset-4 hover:underline">
        Receipts
      </Link>
    </p>
  );
}

const how = (row: Pick<ReceiptRow, "method" | "chequeNumber">) => (row.method === "cheque" ? `Cheque ${row.chequeNumber ?? ""}` : METHOD_LABELS[row.method]);
const plain = (value: { toFixed(n: number): string }) => value.toFixed(AMOUNT_SCALE).replace(/\.?0+$/, "");

// ── the list ────────────────────────────────────────────────────────────────────────────────────

export async function ReceiptsScreen() {
  const session = await requireTenant();
  if (!can(session.role, "receipt.read") || !session.modules.collections) return <Refused title="Receipts" />;
  const { rows, more } = await listReceipts(session);
  return (
    <>
      <PageHead title="Receipts" sub="Money received from customers: in cash, into the bank, or by cheque." />
      <Sections current="/receipts" />
      {can(session.role, "receipt.manage") ? (
        <p className="mb-4">
          <Link href="/receipts/new" className={buttonVariants()}>
            New receipt
          </Link>
        </p>
      ) : null}
      <Card className="max-w-4xl">
        {rows.length === 0 ? (
          <Empty>No receipts yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Receipts" className="w-full min-w-[620px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 font-medium">How it came</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/receipts/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.customerName}</td>
                    <td className="py-2 pr-4">
                      {how(row)}
                      {row.chequeStage && row.status === "posted" ? <span className="text-muted-foreground"> · {STAGE_LABELS[row.chequeStage]}</span> : null}
                    </td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(row.amount)}</td>
                    <td className="py-2">
                      <StatusPill status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 receipts.</p> : null}
      </Card>
    </>
  );
}

// ── cheques ─────────────────────────────────────────────────────────────────────────────────────

export async function ChequesScreen({ searchParams }: { searchParams: Promise<{ all?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "receipt.read") || !session.modules.collections) return <Refused title="Cheques" />;
  const all = typeof (await searchParams).all === "string";
  const { rows, more, inHand, deposited } = await listCheques(session, all);
  const today = todayIso(new Date());
  return (
    <>
      <PageHead title="Cheques" sub="Cheques received from customers: in hand, at the bank, and what became of them." />
      <Sections current="/receipts/cheques" />
      <dl className="mb-4 flex max-w-4xl flex-wrap gap-x-10 gap-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">In hand</dt>
          <dd className="text-lg font-bold tabular-nums" data-testid="cheques-in-hand">
            {formatAmount(inHand)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Deposited, not yet cleared</dt>
          <dd className="text-lg font-bold tabular-nums" data-testid="cheques-deposited">
            {formatAmount(deposited)}
          </dd>
        </div>
      </dl>
      <p className="mb-3 text-sm">
        {all ? (
          <Link href="/receipts/cheques" className="text-muted-foreground underline-offset-4 hover:underline">
            Show only cheques still to clear
          </Link>
        ) : (
          <Link href="/receipts/cheques?all=1" className="text-muted-foreground underline-offset-4 hover:underline">
            Show cleared, bounced and cancelled cheques too
          </Link>
        )}
      </p>
      <Card className="max-w-4xl">
        {rows.length === 0 ? (
          <Empty>{all ? "No cheques yet." : "No cheques are waiting to be deposited or cleared."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Cheques" className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Cheque</th>
                  <th className="py-2 pr-4 font-medium">Bank</th>
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 font-medium">Date on it</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 pr-4 font-medium">Where it stands</th>
                  <th className="py-2 font-medium">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => {
                  const due = row.status === "posted" && row.chequeStage === "received" && (row.chequeDate ?? "") <= today;
                  return (
                    <tr key={row.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.chequeNumber}</td>
                      <td className="py-2 pr-4">{row.chequeBank}</td>
                      <td className="py-2 pr-4">{row.customerName}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{row.chequeDate ? formatIsoDate(row.chequeDate) : ""}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(row.amount)}</td>
                      <td className="py-2 pr-4">
                        {row.status === "cancelled" ? "Cancelled" : row.chequeStage ? STAGE_LABELS[row.chequeStage] : ""}
                        {due ? <span className="font-semibold text-primary"> · can be deposited</span> : null}
                        {row.status === "posted" && row.chequeStage === "received" && !due ? <span className="text-muted-foreground"> · post-dated</span> : null}
                      </td>
                      <td className="py-2 whitespace-nowrap">
                        <Link href={`/receipts/${row.id}`} className="underline-offset-4 hover:underline">
                          {row.number}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the first 200 cheques.</p> : null}
      </Card>
    </>
  );
}

// ── a new receipt ───────────────────────────────────────────────────────────────────────────────

async function formChoices(session: TenantSession) {
  const [accounts, branches] = await Promise.all([listMoneyAccounts(session), listBranches(session)]);
  return {
    accounts: accounts.map((account) => ({ id: account.id, label: `${account.code} ${account.name}`, kind: account.kind })),
    branches: branches.filter((branch) => seesBranch(session.branchIds, branch.id)).map((branch) => ({ id: branch.id, name: branch.name })),
    mustChooseBranch: session.branchIds !== null,
  };
}

const openRows = (items: readonly OpenItem[], today: string): OpenRow[] =>
  items.map((item) => ({ kind: item.kind, id: item.id, number: item.number, date: formatIsoDate(item.date), dueDate: formatIsoDate(item.dueDate), overdue: item.dueDate < today, outstanding: plain(item.outstanding) }));

export async function NewReceiptScreen({ searchParams }: { searchParams: Promise<{ customer?: string | string[]; q?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "receipt.manage") || !session.modules.collections) {
    return (
      <>
        <PageHead title="New receipt" />
        <p className="text-muted-foreground">Only an owner, an accountant or the recovery officer can record receipts.</p>
      </>
    );
  }
  const query = await searchParams;
  const customerId = typeof query.customer === "string" ? query.customer : "";
  const typed = typeof query.q === "string" ? query.q.slice(0, 80) : "";
  const today = todayIso(new Date());

  if (customerId !== "") {
    const standing = await getCustomerStanding(session, customerId);
    if (!standing) notFound();
    const choices = await formChoices(session);
    return (
      <>
        <Back />
        <PageHead title={`Receipt from ${standing.name}`} sub={`The books say ${standing.name} owes ${formatAmount(standing.owes)}.`} />
        <Card className="max-w-4xl">
          <ReceiptForm
            action={saveReceiptAction.bind(null, null, standing.id, "")}
            {...choices}
            open={openRows(standing.items, today)}
            initial={{ date: today, method: "cash", accountId: "", amount: "", bankCharges: "", reference: "", note: "", branchId: "", chequeNumber: "", chequeBank: "", chequeDate: today, paying: {} }}
          />
        </Card>
      </>
    );
  }

  const found = typed.trim() === "" ? [] : await findCustomers(session, typed);
  return (
    <>
      <Back />
      <PageHead title="New receipt" sub="Whose money is it? Find the customer by name or code." />
      <Card className="max-w-2xl">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field label="Customer name or code" name="q" defaultValue={typed} autoComplete="off" autoFocus required className="w-72" />
          <button type="submit" className={buttonVariants()}>
            Find
          </button>
        </form>
        {typed.trim() === "" ? null : found.length === 0 ? (
          <Empty>No customer matches.</Empty>
        ) : (
          <ul aria-label="Customers found" className="mt-4 divide-y text-sm">
            {found.map((customer) => (
              <li key={customer.id} className="flex flex-wrap items-baseline gap-x-3 py-2.5">
                <Link href={`/receipts/new?customer=${customer.id}`} className="font-medium underline-offset-4 hover:underline">
                  {customer.name}
                </Link>
                <span className="text-muted-foreground">
                  {customer.code}
                  {customer.archived ? " · archived" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ── one receipt ─────────────────────────────────────────────────────────────────────────────────

function PaidTable({ receipt }: { receipt: Receipt }) {
  if (receipt.paid.length === 0) return <p className="text-sm text-muted-foreground">Nothing of it is set against an invoice.</p>;
  return (
    <div className="overflow-x-auto">
      <table aria-label="What it pays" className="w-full min-w-[480px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Invoice</th>
            <th className="py-2 pr-4 font-medium">Invoice date</th>
            <th className="py-2 pr-4 font-medium">Paid from</th>
            <th className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {receipt.paid.map((row) => (
            <tr key={row.id} className={receipt.status !== "draft" && !row.counts ? "text-muted-foreground line-through" : undefined}>
              <td className="py-2 pr-4 font-medium whitespace-nowrap">
                {row.number}
                {row.kind === "opening" ? <span className="font-normal text-muted-foreground"> (opening balance)</span> : null}
              </td>
              <td className="py-2 pr-4 whitespace-nowrap">{row.date ? formatIsoDate(row.date) : ""}</td>
              <td className="py-2 pr-4 whitespace-nowrap">
                {row.allocatedOn ? formatIsoDate(row.allocatedOn) : ""}
                {row.later ? <span className="text-muted-foreground"> · from the advance</span> : null}
              </td>
              <td className="py-2 text-right whitespace-nowrap tabular-nums">{formatAmount(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function ReceiptScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "receipt.read") || !session.modules.collections) return <Refused title="Receipt" />;
  const [{ id }, { refused }] = await Promise.all([params, searchParams]);
  const receipt = await getReceipt(session, id);
  if (!receipt) notFound();
  const manager = can(session.role, "receipt.manage");
  const loadedAt = receipt.updatedAt.toISOString();
  const today = todayIso(new Date());
  const latest = (...days: (string | null)[]) => days.reduce<string>((max, day) => (day !== null && day > max ? day : max), today);

  if (receipt.status === "draft" && manager) {
    const [choices, items] = await Promise.all([formChoices(session), listOpenItems(session, receipt.customerId)]);
    return (
      <>
        <Back />
        <PageHead title={`Draft receipt from ${receipt.customerName}`} sub="Not in the books yet. It gets its number when it is posted." />
        <div className="flex max-w-4xl flex-col gap-5">
          <Card>
            <ReceiptForm
              action={saveReceiptAction.bind(null, receipt.id, receipt.customerId, loadedAt)}
              {...choices}
              open={openRows(items, today)}
              initial={{
                date: receipt.date,
                method: receipt.method,
                accountId: receipt.accountId ?? "",
                amount: plain(receipt.amount),
                bankCharges: receipt.bankCharges.isZero() ? "" : plain(receipt.bankCharges),
                reference: receipt.reference ?? "",
                note: receipt.note ?? "",
                branchId: receipt.branchId ?? "",
                chequeNumber: receipt.chequeNumber ?? "",
                chequeBank: receipt.chequeBank ?? "",
                chequeDate: receipt.chequeDate ?? today,
                paying: Object.fromEntries(receipt.paid.map((row) => [`${row.kind}:${row.targetId}`, plain(row.amount)])),
              }}
              refused={typeof refused === "string" && refused !== "" ? "Saved as a draft, but not posted. Post it again to see why." : undefined}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardReceiptAction.bind(null, receipt.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const standing = receipt.status === "posted";
  const cheque = receipt.method === "cheque";
  const [accounts, items] = await Promise.all([
    standing && manager && cheque && receipt.chequeStage === "received" ? listMoneyAccounts(session) : [],
    standing && manager && receipt.advance.gt(0) ? listOpenItems(session, receipt.customerId) : [],
  ]);
  const banks = accounts.filter((account) => account.kind === "bank");
  return (
    <>
      <Back />
      <PageHead title={receipt.number ?? "Draft receipt"} sub={`From ${receipt.customerName}`} />
      <div className="flex max-w-4xl flex-col gap-5">
        <Card>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Date received</dt>
            <dd>{formatIsoDate(receipt.date)}</dd>
            <dt className="text-muted-foreground">How it came</dt>
            <dd>{METHOD_LABELS[receipt.method]}</dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="font-semibold tabular-nums" data-testid="receipt-amount">
              {formatAmount(receipt.amount)}
              {receipt.bankCharges.gt(0) ? <span className="font-normal text-muted-foreground"> of which the bank kept {formatAmount(receipt.bankCharges)}</span> : null}
            </dd>
            {cheque ? (
              <>
                <dt className="text-muted-foreground">Cheque</dt>
                <dd>
                  {receipt.chequeNumber}, {receipt.chequeBank}, dated {receipt.chequeDate ? formatIsoDate(receipt.chequeDate) : ""}
                </dd>
                <dt className="text-muted-foreground">Where it stands</dt>
                <dd data-testid="cheque-stage">
                  {receipt.status === "cancelled" ? "Cancelled" : receipt.chequeStage ? STAGE_LABELS[receipt.chequeStage] : ""}
                  {receipt.depositedOn ? <span className="text-muted-foreground"> · deposited {formatIsoDate(receipt.depositedOn)}</span> : null}
                  {receipt.clearedOn ? <span className="text-muted-foreground"> · cleared {formatIsoDate(receipt.clearedOn)}</span> : null}
                  {receipt.bouncedOn ? <span className="text-muted-foreground"> · bounced {formatIsoDate(receipt.bouncedOn)}: {receipt.bounceReason}</span> : null}
                </dd>
              </>
            ) : null}
            {receipt.reference ? (
              <>
                <dt className="text-muted-foreground">Reference</dt>
                <dd>{receipt.reference}</dd>
              </>
            ) : null}
            {receipt.note ? (
              <>
                <dt className="text-muted-foreground">Note</dt>
                <dd>{receipt.note}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <StatusPill status={receipt.status} testId="document-status" />
              {receipt.status === "cancelled" ? <span className="text-muted-foreground"> {receipt.cancelReason}. What it paid is unpaid again.</span> : null}
              {receipt.status === "bounced" ? <span className="text-muted-foreground"> The invoices it paid are unpaid again. When the customer pays, record a new receipt.</span> : null}
            </dd>
          </dl>
          <h2 className="mb-1 text-sm font-semibold">What it pays</h2>
          <PaidTable receipt={receipt} />
          {standing ? (
            <p className="mt-3 text-sm" data-testid="receipt-advance">
              {receipt.advance.gt(0) ? (
                <>
                  Not set against an invoice, kept as the customer&apos;s advance: <span className="font-semibold tabular-nums">{formatAmount(receipt.advance)}</span>.
                </>
              ) : (
                <span className="text-muted-foreground">All of it is set against invoices.</span>
              )}
            </p>
          ) : null}
        </Card>

        {standing && manager && receipt.advance.gt(0) && items.length > 0 ? (
          <Card title="Set the advance against invoices">
            <ActionForm action={applyAdvanceAction.bind(null, receipt.id, loadedAt)} submitLabel="Set against these invoices">
              <Field label="From" name="date" id="apply-date" type="date" defaultValue={latest(receipt.date)} min={receipt.date} required className="max-w-[12rem]" />
              <div className="overflow-x-auto">
                <table aria-label="Unpaid invoices" className="w-full min-w-[480px] text-left text-sm">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Invoice</th>
                      <th className="py-2 pr-4 font-medium">Date</th>
                      <th className="py-2 pr-4 text-right font-medium">Still to pay</th>
                      <th className="w-36 py-2 text-right font-medium">From the advance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {items.map((item) => (
                      <tr key={`${item.kind}:${item.id}`}>
                        <td className="py-1 pr-4 font-medium whitespace-nowrap">
                          {item.number}
                          <input type="hidden" name="allocKind" value={item.kind} />
                          <input type="hidden" name="allocId" value={item.id} />
                          <input type="hidden" name="allocLabel" value={item.number} />
                        </td>
                        <td className="py-1 pr-4 whitespace-nowrap">{formatIsoDate(item.date)}</td>
                        <td className="py-1 pr-4 text-right tabular-nums">{formatAmount(item.outstanding)}</td>
                        <td className="py-1">
                          <input name="allocAmount" aria-label={`From the advance, ${item.number}`} inputMode="decimal" autoComplete="off" className={`${SELECT} text-right tabular-nums`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ActionForm>
          </Card>
        ) : null}

        {standing && manager && cheque && receipt.chequeStage === "received" ? (
          <Card title="Deposit the cheque">
            {(receipt.chequeDate ?? today) > today ? (
              <p className="text-sm text-muted-foreground">This cheque is post-dated. It can be deposited from {formatIsoDate(receipt.chequeDate ?? today)}.</p>
            ) : banks.length === 0 ? (
              <p className="text-sm text-muted-foreground">There is no bank account yet. An owner or an accountant adds one under Chart of accounts, Bank accounts.</p>
            ) : (
              <ActionForm action={depositChequeAction.bind(null, receipt.id, loadedAt)} submitLabel="Mark as deposited">
                <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="deposit-account" className="text-sm font-medium">
                      Bank account it was deposited in
                    </label>
                    <select id="deposit-account" name="accountId" defaultValue={banks.length === 1 ? banks[0].id : ""} required className={SELECT}>
                      <option value="">Choose a bank account</option>
                      {banks.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Field label="Deposited on" name="date" id="deposit-date" type="date" defaultValue={latest(receipt.date, receipt.chequeDate)} min={latest(receipt.date, receipt.chequeDate) === today ? undefined : latest(receipt.date, receipt.chequeDate)} required />
                </div>
              </ActionForm>
            )}
          </Card>
        ) : null}

        {standing && manager && cheque && receipt.chequeStage === "deposited" ? (
          <Card title="The cheque has cleared">
            <p className="mb-3 text-sm text-muted-foreground">The money is in the bank account. Until then it stays in Cheques in hand.</p>
            <ActionForm action={clearChequeAction.bind(null, receipt.id, loadedAt)} submitLabel="Mark as cleared">
              <div className="grid max-w-md gap-4 sm:grid-cols-2">
                <Field label="Cleared on" name="date" id="clear-date" type="date" defaultValue={latest(receipt.depositedOn)} min={receipt.depositedOn ?? undefined} required />
                <Field label="Kept by the bank" name="bankCharges" id="clear-charges" inputMode="decimal" autoComplete="off" className="text-right tabular-nums" />
              </div>
            </ActionForm>
          </Card>
        ) : null}

        {standing && manager && cheque ? (
          <Card title="The cheque has bounced">
            <p className="mb-3 text-sm text-muted-foreground">Everything this receipt posted is taken back on the day you give, and the invoices it paid are unpaid again.</p>
            <ActionForm action={bounceChequeAction.bind(null, receipt.id, loadedAt)} submitLabel="Mark as bounced">
              <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
                <Field label="Bounced on" name="date" id="bounce-date" type="date" defaultValue={latest(receipt.clearedOn, receipt.depositedOn, receipt.date)} required />
                <Field label="Why" name="reason" id="bounce-reason" required minLength={3} maxLength={300} autoComplete="off" placeholder="Such as: insufficient funds" />
              </div>
            </ActionForm>
          </Card>
        ) : null}

        {standing && manager && (!cheque || receipt.chequeStage === "received") ? (
          <Card title="Cancel this receipt">
            <p className="mb-3 text-sm text-muted-foreground">
              For a receipt entered by mistake. A posted receipt is never changed or deleted: cancelling it takes back what it posted on the day you give, and what it paid is unpaid again.
            </p>
            <ActionForm action={cancelReceiptAction.bind(null, receipt.id, loadedAt)} submitLabel="Cancel receipt">
              <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
                <Field label="Cancelled on" name="date" id="cancel-date" type="date" defaultValue={latest(receipt.date)} min={receipt.date} required />
                <Field label="Why it is cancelled" name="reason" id="cancel-reason" required minLength={3} maxLength={300} autoComplete="off" />
              </div>
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}
