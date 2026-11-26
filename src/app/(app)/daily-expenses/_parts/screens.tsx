import Link from "next/link";
import Decimal from "decimal.js";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getDailyChoices, listDailyExpenses, MAX_DAILY_ROWS, type DailyRow } from "@/modules/daily-expenses/queries";
import { groupByDay, MAX_SHEET_EXPENSES, NOTHING_WITHHELD, readRange, SHEET_COLUMNS, type DayOf } from "@/modules/daily-expenses/rules";
import { FILE_MAX_BYTES } from "@/modules/files/rules";
import { can } from "@/modules/tenant/rules";
import { closed, Shut } from "../../cash-bank/_parts/screens";
import { addDailyExpenseAction, previewSheetAction, recordSheetAction } from "./actions";
import { QuickAddForm } from "./quick-form";
import { RECEIPT_TYPES } from "./receipts";
import { SheetForm } from "./sheet-form";

type Session = Awaited<ReturnType<typeof requireTenant>>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const TITLE = "Daily expenses";
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const count = (n: number) => `${n} ${n === 1 ? "expense" : "expenses"}`;

/** The branches a form offers: this person's own when they are limited to some; all of them when the company has more than one; none otherwise. */
function branchChoices(session: Session, branches: readonly { id: string; name: string }[]) {
  const whole = session.branchIds === null;
  const mine = branches.filter((b) => whole || session.branchIds!.includes(b.id)).map((b) => ({ id: b.id, label: b.name }));
  return { wholeCompany: whole, branches: whole && branches.length < 2 ? [] : mine };
}

function DayTable({ day, label }: { day: DayOf<DailyRow>; label: string }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="w-36 py-2 pr-4 font-medium">Number</th>
            <th className="py-2 pr-4 font-medium">What for</th>
            <th className="py-2 pr-4 font-medium">Paid to</th>
            <th className="py-2 pr-4 font-medium">Paid from</th>
            <th className="w-32 py-2 pr-4 text-right font-medium">Amount</th>
            <th className="w-24 py-2 font-medium">Receipt</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {day.rows.map((row) => (
            <tr key={row.id} className={row.status === "cancelled" ? "text-muted-foreground" : undefined}>
              <td className="py-2 pr-4 font-medium whitespace-nowrap">
                <Link href={`/cash-bank/expenses/${row.id}?from=daily`} className="underline-offset-4 hover:underline">
                  {row.number}
                </Link>
              </td>
              <td className="py-2 pr-4">
                {row.whatFor}
                {row.moreLines > 0 ? ` and ${row.moreLines} more` : ""}
                {row.description !== row.whatFor ? <span className="block text-xs text-muted-foreground">{row.description}</span> : null}
              </td>
              <td className="py-2 pr-4">{row.paidTo ?? ""}</td>
              <td className="py-2 pr-4">{row.from}</td>
              <td className={`py-2 pr-4 text-right tabular-nums ${row.status === "cancelled" ? "line-through" : ""}`}>{formatAmount(row.total)}</td>
              <td className="py-2 whitespace-nowrap">
                {row.status === "cancelled" ? "Cancelled" : row.receipts > 0 ? `${row.receipts} kept` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function DailyExpensesScreen({ searchParams }: { searchParams: Search }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title={TITLE} why={why} />;
  const params = await searchParams;
  const today = todayIso(new Date());
  const range = readRange(first(params.from), first(params.to), today);
  const keeper = can(session.role, "cash_bank.manage");
  const [choices, list] = await Promise.all([keeper ? getDailyChoices(session) : null, listDailyExpenses(session, range.from, range.to)]);
  const days = groupByDay(list.rows);
  const todays = days.find((day) => day.date === today) ?? null;
  const earlier = days.filter((day) => day.date !== today);
  const spent = days.reduce((sum, day) => sum.plus(day.total), new Decimal(0));
  const entries = days.reduce((sum, day) => sum + day.count, 0);
  const offered = choices ? branchChoices(session, choices.branches) : null;
  return (
    <>
      <PageHead title={TITLE} sub="What the company spends each day, entered as it is paid, with its receipt. Each one is in the books at once." />
      <div className="flex max-w-5xl flex-col gap-5">
        {choices && offered ? (
          <Card title="Add an expense">
            {choices.moneyAccounts.length === 0 || choices.expenseAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="cannot-add">
                {choices.moneyAccounts.length === 0
                  ? "There is no cash or bank account to pay from yet. Add one under Cash and bank, Accounts."
                  : "The chart of accounts has no expense account in use. Add one under Settings, Chart of accounts."}
              </p>
            ) : (
              <>
                <QuickAddForm
                  action={addDailyExpenseAction}
                  today={today}
                  expenseAccounts={choices.expenseAccounts.map((a) => ({ id: a.id, label: a.name }))}
                  moneyAccounts={choices.moneyAccounts.map((a) => ({ id: a.id, label: a.name }))}
                  paidFromId={choices.lastPaidFromId ?? (choices.moneyAccounts.length === 1 ? choices.moneyAccounts[0].id : "")}
                  branches={offered.branches}
                  wholeCompany={offered.wholeCompany}
                  maxReceiptBytes={FILE_MAX_BYTES}
                  receiptTypes={RECEIPT_TYPES}
                  taxNote={NOTHING_WITHHELD}
                />
                <p className="mt-4 border-t pt-3 text-sm">
                  Many at once?{" "}
                  <Link href="/daily-expenses/import" className="font-medium underline underline-offset-4">
                    Upload a sheet of expenses
                  </Link>
                </p>
              </>
            )}
          </Card>
        ) : null}

        {range.to === today ? (
          <Card title={`Today, ${formatIsoDate(today)}`}>
            <p className="mb-3 text-sm" data-testid="today-total">
              <span className="text-xl font-bold tabular-nums">{formatAmount(todays?.total ?? new Decimal(0))}</span> spent today{todays ? `, in ${count(todays.count)}` : ""}.
            </p>
            {todays ? <DayTable day={todays} label="Today's expenses" /> : <Empty>Nothing has been entered today.</Empty>}
          </Card>
        ) : null}

        <Card title={range.to === today ? "Earlier days" : "The days chosen"}>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from">From</Label>
              <Input id="from" name="from" type="date" defaultValue={range.from} max={today} className="w-40" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="to">To</Label>
              <Input id="to" name="to" type="date" defaultValue={range.to} max={today} className="w-40" />
            </div>
            <button type="submit" className={buttonVariants({ variant: "outline" })}>
              Show
            </button>
            {range.asked ? (
              <Link href="/daily-expenses" className="pb-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline">
                The last thirty days
              </Link>
            ) : null}
          </form>
          <p className="mb-3 text-sm" data-testid="range-total">
            {formatIsoDate(range.from)} to {formatIsoDate(range.to)}: <span className="font-semibold tabular-nums">{formatAmount(spent)}</span> in {count(entries)}.
            {list.more ? ` Only the newest ${MAX_DAILY_ROWS} are shown and counted: choose fewer days to see the rest.` : ""}
          </p>
          {earlier.length === 0 ? (
            <Empty>{range.to === today ? "No expenses on the earlier days." : "No expenses on these days."}</Empty>
          ) : (
            <div className="flex flex-col gap-5">
              {earlier.map((day) => (
                <section key={day.date} aria-label={formatIsoDate(day.date)}>
                  <h3 className="mb-1 flex flex-wrap items-baseline justify-between gap-2 border-b pb-1 text-sm font-semibold" data-testid="day-total">
                    <span>{formatIsoDate(day.date)}</span>
                    <span className="tabular-nums">
                      {formatAmount(day.total)} <span className="font-normal text-muted-foreground">in {count(day.count)}</span>
                    </span>
                  </h3>
                  <DayTable day={day} label={`Expenses of ${formatIsoDate(day.date)}`} />
                </section>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export async function ImportExpensesScreen() {
  const session = await requireTenant();
  const title = "Upload a sheet of expenses";
  const why = closed(session) ?? (can(session.role, "cash_bank.manage") ? null : "Only the owner or an accountant enters the company's expenses.");
  if (why) return <Shut title={title} why={why} />;
  const choices = await getDailyChoices(session);
  const offered = branchChoices(session, choices.branches);
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/daily-expenses" className="text-muted-foreground underline-offset-4 hover:underline">
          {TITLE}
        </Link>
      </p>
      <PageHead title={title} sub="Many expenses entered in one go from an Excel or CSV file. You see every row before anything is entered, and then all of them are entered or none." />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card title="1. Fill in the sheet">
          <div className="flex flex-col gap-3 text-sm">
            <p>
              <a href="/daily-expenses/import/template" className={buttonVariants({ variant: "outline" })}>
                Download the template
              </a>
            </p>
            <p>
              One row for each expense, under these headings: <span className="font-medium">{SHEET_COLUMNS.join(", ")}</span>. Paid to and Note may be left empty. Up to {MAX_SHEET_EXPENSES} rows.
            </p>
            <ul className="list-disc pl-5 text-muted-foreground">
              <li>Date: the day first, such as 26/11/2026, or as Excel keeps a date. Not a day that has not come.</li>
              <li>What for: the name of one of your expense accounts, exactly as below.</li>
              <li>Amount: rupees, such as 500 or 1,250.50.</li>
              <li>Paid from: the name of one of your cash or bank accounts, exactly as below.</li>
            </ul>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 font-medium">What for: your expense accounts</p>
                <p className="text-muted-foreground" data-testid="expense-account-names">
                  {choices.expenseAccounts.length === 0 ? "None yet. Add one under Settings, Chart of accounts." : choices.expenseAccounts.map((a) => a.name).join(", ")}
                </p>
              </div>
              <div>
                <p className="mb-1 font-medium">Paid from: your cash and bank accounts</p>
                <p className="text-muted-foreground" data-testid="money-account-names">
                  {choices.moneyAccounts.length === 0 ? "None yet. Add one under Cash and bank, Accounts." : choices.moneyAccounts.map((a) => a.name).join(", ")}
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{NOTHING_WITHHELD}</p>
          </div>
        </Card>
        <Card title="2. Upload it and look it over">
          <SheetForm preview={previewSheetAction} record={recordSheetAction} branches={offered.branches} wholeCompany={offered.wholeCompany} />
        </Card>
      </div>
    </>
  );
}
