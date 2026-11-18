import Link from "next/link";
import { Card } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Field } from "@/components/field";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getOwnerFigures } from "@/modules/reports/queries";
import { filterQuery, readFilter } from "@/modules/reports/rules";
import { listBranches } from "@/modules/tenant/queries";

// Step 36: the owner's figures on Home, for a period and a branch: what cash and bank hold, sales,
// profit, and what is owed each way. Each opens the report it comes from, for the same period.

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

type Session = Awaited<ReturnType<typeof requireTenant>>;

function Tile({ label, value, note, href, testId }: { label: string; value: string; note?: string; href: string; testId: string }) {
  return (
    <Link href={href} className="flex flex-col gap-1 rounded-[10px] border bg-card p-4 shadow-xs hover:border-primary" data-testid={testId}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </Link>
  );
}

/** The owner's figures, read for the period and branch in the address; this month so far when none is given. */
export async function OwnerFigures({ session, raw }: { session: Session; raw: Record<string, string | string[] | undefined> }) {
  const today = todayIso(new Date());
  const filter = readFilter(raw, { yearStart: `${today.slice(0, 8)}01`, today });
  const [figures, branches] = await Promise.all([getOwnerFigures(session, filter), listBranches(session)]);
  const query = filterQuery(filter);
  const signed = (amount: Parameters<typeof formatAmount>[0]) => `${amount.isNegative() ? "less " : ""}${formatAmount(amount.abs())}`;
  return (
    <Card title="The business" className="mb-5">
      {/* A plain form: the period travels in the address, as the reports' does. */}
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From" name="from" type="date" defaultValue={filter.from} required />
        <Field label="To" name="to" type="date" defaultValue={filter.to} required />
        {branches.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch">Branch</Label>
            <select id="branch" name="branch" defaultValue={filter.branchId ?? ""} className={SELECT}>
              <option value="">Whole company</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Button type="submit">Show</Button>
      </form>
      <p className="mb-3 text-sm text-muted-foreground" data-testid="figures-period">
        {formatIsoDate(filter.from)} to {formatIsoDate(filter.to)}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile label="Cash and bank" value={formatAmount(figures.cash)} note={`${signed(figures.cashChange)} in the period`} href={`/reports/cash-flow?${query}`} testId="figure-cash" />
        <Tile label="Sales" value={formatAmount(figures.sales)} href={`/reports/profit-and-loss?${query}`} testId="figure-sales" />
        <Tile label={figures.profit.isNegative() ? "Loss" : "Profit"} value={formatAmount(figures.profit.abs())} href={`/reports/profit-and-loss?${query}`} testId="figure-profit" />
        <Tile label="Customers owe" value={formatAmount(figures.receivables)} note={`at the end of ${formatIsoDate(filter.to)}`} href={`/reports/balance-sheet?${query}`} testId="figure-receivables" />
        <Tile label="Owed to suppliers" value={formatAmount(figures.payables)} note={`at the end of ${formatIsoDate(filter.to)}`} href={`/reports/balance-sheet?${query}`} testId="figure-payables" />
      </div>
    </Card>
  );
}
