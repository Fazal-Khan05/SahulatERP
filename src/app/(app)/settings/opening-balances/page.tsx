import Decimal from "decimal.js";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listAccounts } from "@/modules/ledger/queries";
import { visibleAccounts } from "@/modules/ledger/rules";
import { listFiscalPeriods } from "@/modules/numbering/queries";
import { ageOpening, getOpening, type OpeningEntry, type OpeningLine } from "@/modules/opening/queries";
import { AGE_BANDS, KIND_WORDS, OPENING_IMPORT_MAX_BYTES, accountLineRefusal, openingJournal, type PartyKind } from "@/modules/opening/rules";
import { getCompanySetup } from "@/modules/setup/queries";
import { can } from "@/modules/tenant/rules";
import { ImportForm } from "../../_parties/import-form";
import {
  addOpenDocumentAction,
  discardOpeningAction,
  importOpeningAction,
  postOpeningAction,
  removeOpeningLineAction,
  reverseOpeningAction,
  setAccountBalanceAction,
  setOpeningDateAction,
  startOpeningAction,
} from "./actions";

export const metadata: Metadata = { title: "Opening balances" };

export default function OpeningBalancesPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Opening />
    </Suspense>
  );
}

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const money = "py-2 pr-4 text-right whitespace-nowrap tabular-nums";

async function Opening() {
  const session = await requireTenant();
  if (!can(session.role, "opening.read")) {
    return <p className="text-muted-foreground">Only an owner, an accountant or an auditor can see the opening balances.</p>;
  }
  if (session.branchIds !== null) {
    return <p className="text-muted-foreground">Opening balances belong to the whole company. They are entered and read by someone who works in every branch.</p>;
  }
  const manager = can(session.role, "opening.manage");
  const entry = await getOpening(session);

  if (!entry) {
    const periods = manager ? await listFiscalPeriods(session) : [];
    return (
      <Card title="Opening balances" className="max-w-xl">
        <p className="mb-3 text-sm text-muted-foreground">
          The books this company brings with it: what each account stood at, every customer invoice still unpaid and every supplier
          bill still unpaid, on the day before the books are first kept here.
        </p>
        {manager ? (
          <ActionForm action={startOpeningAction} submitLabel="Start opening balances">
            <Field
              label="Opening date"
              name="date"
              type="date"
              defaultValue={periods[0]?.startsOn ?? todayIso(new Date())}
              required
              hint="The first day the books are kept here. Balances are as they stood at the end of the day before."
            />
          </ActionForm>
        ) : (
          <Empty>No opening balances have been entered.</Empty>
        )}
      </Card>
    );
  }

  const draft = entry.status === "draft";
  const editable = draft && manager;
  const loadedAt = entry.updatedAt.toISOString();
  const lines = (kind: OpeningLine["kind"]) => entry.lines.filter((line) => line.kind === kind);
  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Summary entry={entry} editable={editable} manager={manager} loadedAt={loadedAt} />
      <AccountsCard lines={lines("account")} editable={editable} loadedAt={loadedAt} salesTaxRegistered={editable ? ((await getCompanySetup(session))?.salesTaxRegistered ?? true) : true} session={session} />
      <DocumentsCard kind="receivable" lines={lines("receivable")} editable={editable} loadedAt={loadedAt} />
      <DocumentsCard kind="payable" lines={lines("payable")} editable={editable} loadedAt={loadedAt} />
      {!draft ? (
        <>
          <AgeCard entry={entry} kind="receivable" />
          <AgeCard entry={entry} kind="payable" />
        </>
      ) : null}
    </div>
  );
}

function Summary({ entry, editable, manager, loadedAt }: { entry: OpeningEntry; editable: boolean; manager: boolean; loadedAt: string }) {
  // The same sum the posting makes, with stand-in accounts: only the totals are shown here.
  const journal = openingJournal(
    entry.lines.map((line) =>
      line.kind === "account"
        ? { kind: "account", accountId: line.accountId ?? "", debit: line.debit, credit: line.credit }
        : line.kind === "receivable"
          ? { kind: "receivable", customerId: line.customerId ?? "", amount: line.debit }
          : { kind: "payable", supplierId: line.supplierId ?? "", amount: line.credit },
    ),
    { receivables: "receivables", payables: "payables", openingEquity: "equity" },
  );
  const sum = (kind: OpeningLine["kind"], side: "debit" | "credit") => entry.lines.filter((line) => line.kind === kind).reduce((total, line) => total.plus(line[side]), new Decimal(0));
  const difference = journal.difference;
  return (
    <Card title="Opening balances">
      <p className="mb-3 text-sm" data-testid="opening-status">
        {entry.status === "draft" ? "Draft: not in the books yet." : `Posted on ${entry.postedAt ? formatIsoDate(todayIso(entry.postedAt)) : ""}, as at the start of ${formatIsoDate(entry.openingDate)}.`}
      </p>
      {editable ? (
        <ActionForm action={setOpeningDateAction.bind(null, loadedAt)} submitLabel="Change date" className="mb-4 max-w-xs">
          <Field label="Opening date" name="date" type="date" defaultValue={entry.openingDate} required hint="The first day the books are kept here. Balances are as they stood at the end of the day before." />
        </ActionForm>
      ) : null}
      <div className="overflow-x-auto">
        <table aria-label="Opening balances in total" className="w-full min-w-[420px] max-w-xl text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium" />
              <th className="py-2 pr-4 text-right font-medium">Debit</th>
              <th className="py-2 pr-4 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr>
              <td className="py-2 pr-4">Account balances</td>
              <td className={money}>{formatAmount(sum("account", "debit"))}</td>
              <td className={money}>{formatAmount(sum("account", "credit"))}</td>
            </tr>
            <tr>
              <td className="py-2 pr-4">Customers&apos; unpaid invoices</td>
              <td className={money}>{formatAmount(sum("receivable", "debit"))}</td>
              <td className={money} />
            </tr>
            <tr>
              <td className="py-2 pr-4">Suppliers&apos; unpaid bills</td>
              <td className={money} />
              <td className={money}>{formatAmount(sum("payable", "credit"))}</td>
            </tr>
            <tr className="font-medium">
              <td className="py-2 pr-4">Opening balance equity (what the lines above differ by)</td>
              <td className={money} data-testid="equity-debit">
                {difference.isNegative() ? formatAmount(difference.abs()) : ""}
              </td>
              <td className={money} data-testid="equity-credit">
                {difference.isPositive() && !difference.isZero() ? formatAmount(difference) : ""}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted-foreground" data-testid="equity-note">
        {difference.isZero()
          ? "The lines agree: nothing is left in Opening balance equity."
          : difference.isNegative()
            ? "The amount in Opening balance equity is what these books hold that has not been brought in yet. If your books balanced, it is the value of your stock on that day: stock is entered item by item when stock is set up, and takes this to nil. If it is not your stock's value, a balance is missing or mistyped."
            : "The debits here are more than the credits, so something on the credit side is missing or too small: capital, a loan, or a supplier's bill. Books that balance, with only the stock left out, leave a debit in Opening balance equity equal to the stock's value."}
      </p>
      {editable ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <ActionForm action={postOpeningAction.bind(null, loadedAt)} submitLabel="Post opening balances" compact />
          <ActionForm action={discardOpeningAction.bind(null, loadedAt)} submitLabel="Discard this draft" compact />
        </div>
      ) : null}
      {entry.status === "posted" && manager ? (
        <div className="mt-5 border-t pt-4">
          <h3 className="mb-1 text-sm font-bold">Correct the opening balances</h3>
          <p className="mb-3 text-sm text-muted-foreground">
            Posted balances are never changed. Reversing them posts a second journal, on the opening date, that undoes the first, and
            starts a new draft with the same lines for you to correct and post again.
          </p>
          <ActionForm action={reverseOpeningAction.bind(null, loadedAt)} submitLabel="Reverse and correct" compact />
        </div>
      ) : null}
    </Card>
  );
}

async function AccountsCard({ lines, editable, loadedAt, salesTaxRegistered, session }: { lines: OpeningLine[]; editable: boolean; loadedAt: string; salesTaxRegistered: boolean; session: Awaited<ReturnType<typeof requireTenant>> }) {
  const choices = editable
    ? visibleAccounts(await listAccounts(session), salesTaxRegistered).filter((account) => !account.isGroup && account.archivedAt === null && accountLineRefusal(account.controlType) === null)
    : [];
  return (
    <Card title="Account balances">
      <p className="mb-2 text-sm text-muted-foreground">
        What each account stood at: bank and cash, fixed assets, loans, capital and the rest of the trial balance. Trade receivables,
        trade payables and stock are left out here; they are entered below, and with the stock.
      </p>
      {lines.length === 0 ? (
        <Empty>No account balances yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="Account balances" className="w-full min-w-[480px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Account</th>
                <th className="py-2 pr-4 text-right font-medium">Debit</th>
                <th className="py-2 pr-4 text-right font-medium">Credit</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-4">
                    <span className="font-medium tabular-nums">{line.code}</span> {line.name}
                  </td>
                  <td className={money}>{line.debit.isZero() ? "" : formatAmount(line.debit)}</td>
                  <td className={money}>{line.credit.isZero() ? "" : formatAmount(line.credit)}</td>
                  <td className="py-2 text-right">{editable ? <ActionForm action={removeOpeningLineAction.bind(null, line.id, loadedAt)} submitLabel={`Remove ${line.code}`} compact /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable ? (
        <div className="mt-5 grid gap-6 border-t pt-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-bold">Set one account</h3>
            <ActionForm action={setAccountBalanceAction.bind(null, loadedAt)} submitLabel="Save balance">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="accountId">Account</Label>
                <select id="accountId" name="accountId" required defaultValue="" className={SELECT}>
                  <option value="" disabled>
                    Choose an account
                  </option>
                  {choices.map((account) => (
                    <option key={account.id} value={account.id}>
                      {`${account.code} ${account.name}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field id="account-debit" label="Debit" name="debit" inputMode="decimal" autoComplete="off" />
                <Field id="account-credit" label="Credit" name="credit" inputMode="decimal" autoComplete="off" />
              </div>
              <p className="text-xs text-muted-foreground">One or the other, without commas. Saving an account again corrects it.</p>
            </ActionForm>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-bold">Or import a trial balance</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              A CSV file with the columns Account code, Account name, Debit, Credit, using the codes of the chart of accounts here. A
              name that does not match its code stops the import. Accounts that stand at nil are skipped.{" "}
              <Link href="/settings/accounts" className="underline underline-offset-4">
                See the account codes
              </Link>
            </p>
            <ImportForm id="accounts-file" action={importOpeningAction.bind(null, "account", loadedAt)} many="account balances" maxBytes={OPENING_IMPORT_MAX_BYTES} />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function DocumentsCard({ kind, lines, editable, loadedAt }: { kind: PartyKind; lines: OpeningLine[]; editable: boolean; loadedAt: string }) {
  const words = KIND_WORDS[kind];
  const Party = kind === "receivable" ? "Customer" : "Supplier";
  const Document = kind === "receivable" ? "Invoice" : "Bill";
  const title = kind === "receivable" ? "Receivables: customers' unpaid invoices" : "Payables: suppliers' unpaid bills";
  const total = lines.reduce((sum, line) => sum.plus(kind === "receivable" ? line.debit : line.credit), new Decimal(0));
  return (
    <Card title={title}>
      <p className="mb-2 text-sm text-muted-foreground">
        Each {words.document} still unpaid on the opening date, with its own number and its original date, so that what is owed is aged
        from when it was really {kind === "receivable" ? "invoiced" : "billed"} and can be settled {words.document} by {words.document}.
      </p>
      {lines.length === 0 ? (
        <Empty>No unpaid {words.document}s yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label={kind === "receivable" ? "Unpaid invoices" : "Unpaid bills"} className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">{Party}</th>
                <th className="py-2 pr-4 font-medium">{Document}</th>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Due</th>
                <th className="py-2 pr-4 text-right font-medium">Unpaid</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-4">
                    {line.code ? <span className="font-medium">{line.code} </span> : null}
                    {line.name}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{line.documentNumber}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{line.documentDate ? formatIsoDate(line.documentDate) : ""}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{line.dueDate ? formatIsoDate(line.dueDate) : ""}</td>
                  <td className={money}>{formatAmount(kind === "receivable" ? line.debit : line.credit)}</td>
                  <td className="py-2 text-right">{editable ? <ActionForm action={removeOpeningLineAction.bind(null, line.id, loadedAt)} submitLabel={`Remove ${line.documentNumber}`} compact /> : null}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t font-bold">
              <tr>
                <td className="py-2 pr-4" colSpan={4}>
                  Total
                </td>
                <td className={money}>{formatAmount(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {editable ? (
        <div className="mt-5 grid gap-6 border-t pt-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-bold">Add one {words.document}</h3>
            <ActionForm action={addOpenDocumentAction.bind(null, kind, loadedAt)} submitLabel={`Add ${words.document}`}>
              <Field id={`${kind}-party`} label={Party} name="party" required autoComplete="off" hint={`The ${words.party}'s code or exact name.`} />
              <div className="grid grid-cols-2 gap-3">
                <Field id={`${kind}-number`} label={`${Document} number`} name="documentNumber" required maxLength={40} autoComplete="off" />
                <Field id={`${kind}-amount`} label="Amount unpaid" name="amount" required inputMode="decimal" autoComplete="off" />
                <Field id={`${kind}-date`} label={`${Document} date`} name="documentDate" type="date" required />
                <Field id={`${kind}-due`} label="Due date" name="dueDate" type="date" />
              </div>
            </ActionForm>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-bold">Or import a file</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              A CSV file with the columns {Party}, {Document} number, {Document} date, Due date, Amount unpaid. Dates as 2026-06-30, or
              day first as 30-06-2026. Due date may be left empty.
            </p>
            <ImportForm id={`${kind}-file`} action={importOpeningAction.bind(null, kind, loadedAt)} many={`unpaid ${words.document}s`} maxBytes={OPENING_IMPORT_MAX_BYTES} />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function AgeCard({ entry, kind }: { entry: OpeningEntry; kind: PartyKind }) {
  const today = todayIso(new Date());
  const aged = ageOpening(entry, kind, today);
  if (aged.parties.length === 0) return null;
  const label = kind === "receivable" ? "Receivables by age" : "Payables by age";
  return (
    <Card title={`${label}, as at ${formatIsoDate(today)}`}>
      <p className="mb-2 text-sm text-muted-foreground">
        How old each amount is today, counted from the {KIND_WORDS[kind].document}&apos;s own date, not from the day it was entered here.
        Receipts and payments made since are not taken off yet.
      </p>
      <div className="overflow-x-auto">
        <table aria-label={label} className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">{kind === "receivable" ? "Customer" : "Supplier"}</th>
              {AGE_BANDS.map((band) => (
                <th key={band.label} className="py-2 pr-4 text-right font-medium">
                  {band.label}
                </th>
              ))}
              <th className="py-2 pr-4 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {aged.parties.map((party) => (
              <tr key={party.partyId}>
                <td className="py-2 pr-4">{party.partyName}</td>
                {party.bands.map((amount, index) => (
                  <td key={AGE_BANDS[index].label} className={money}>
                    {amount.isZero() ? "" : formatAmount(amount)}
                  </td>
                ))}
                <td className={`${money} font-medium`}>{formatAmount(party.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t font-bold">
            <tr>
              <td className="py-2 pr-4">Total</td>
              {aged.bands.map((amount, index) => (
                <td key={AGE_BANDS[index].label} className={money}>
                  {amount.isZero() ? "" : formatAmount(amount)}
                </td>
              ))}
              <td className={money}>{formatAmount(aged.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
