import Link from "next/link";
import { PageHead } from "@/components/page-parts";
import type { TenantSession } from "@/lib/auth/session";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import type { CustomerStatement } from "@/modules/recovery/queries";
import { PROMISE_LABELS, type PromiseState } from "@/modules/recovery/rules";
import { can } from "@/modules/tenant/rules";

/** Why this member cannot open the recovery screens, or null. */
export function recoveryRefusal(session: TenantSession): string | null {
  if (!session.modules.collections) return "Collections is switched off for this company.";
  return can(session.role, "recovery.read") ? null : "Your role does not include recovery.";
}

export function Refused({ title, reason }: { title: string; reason: string }) {
  return (
    <>
      <PageHead title={title} />
      <p className="text-muted-foreground">{reason}</p>
    </>
  );
}

type Section = "/recovery/overdue" | "/recovery/follow-ups" | "/recovery/statements" | "/recovery/ageing";

/** The recovery screens, and the receipts screens for those who read them, as a row of links. */
export function Sections({ session, current }: { session: TenantSession; current: Section | null }) {
  const links: [string, string][] = [
    ["/recovery/overdue", "Overdue customers"],
    ["/recovery/follow-ups", "Follow-ups and promises"],
    ["/recovery/statements", "Customer statements"],
    ["/recovery/ageing", "Aged receivables"],
  ];
  if (can(session.role, "receipt.read")) links.push(["/receipts", "Receipts"], ["/receipts/cheques", "Cheques"]);
  return (
    <nav aria-label="Collections" className="mb-4 flex flex-wrap gap-1">
      {links.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={href === current ? "page" : undefined}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${href === current ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function PromisePill({ state }: { state: PromiseState }) {
  const tone = state === "kept" ? "bg-accent text-accent-foreground" : state === "broken" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${tone}`}>{PROMISE_LABELS[state]}</span>;
}

const balance = (amount: CustomerStatement["statement"]["closing"]) => (amount.isNegative() ? `${formatAmount(amount.abs())} in credit` : formatAmount(amount));

/** A customer statement: the same on screen and on the printed page. */
export function StatementBody({ data }: { data: CustomerStatement }) {
  const { statement, open } = data;
  return (
    <>
      <div className="overflow-x-auto">
        <table aria-label="Statement" className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b-2 border-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-semibold">Date</th>
              <th className="py-1.5 pr-3 font-semibold">What</th>
              <th className="py-1.5 pr-3 font-semibold">Number</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Charged</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Paid</th>
              <th className="py-1.5 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr>
              <td className="py-1.5 pr-3 whitespace-nowrap">{formatIsoDate(data.from)}</td>
              <td className="py-1.5 pr-3" colSpan={4}>
                Balance brought forward
              </td>
              <td className="py-1.5 text-right whitespace-nowrap tabular-nums" data-testid="statement-opening">
                {balance(statement.opening)}
              </td>
            </tr>
            {statement.rows.map((row, index) => (
              <tr key={index} className="break-inside-avoid">
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                <td className="py-1.5 pr-3">{row.what}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{row.number ?? ""}</td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">{row.debit.isZero() ? "" : formatAmount(row.debit)}</td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">{row.credit.isZero() ? "" : formatAmount(row.credit)}</td>
                <td className="py-1.5 text-right whitespace-nowrap tabular-nums">{balance(row.balance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-foreground font-bold">
            <tr>
              <td className="py-1.5 pr-3" colSpan={3}>
                Balance on {formatIsoDate(data.to)}
              </td>
              <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">{formatAmount(statement.debits)}</td>
              <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">{formatAmount(statement.credits)}</td>
              <td className="py-1.5 text-right whitespace-nowrap tabular-nums" data-testid="statement-closing">
                {balance(statement.closing)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <h2 className="mt-6 mb-2 font-bold">Unpaid invoices today</h2>
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is unpaid.</p>
      ) : (
        <table aria-label="Unpaid invoices" className="w-full text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Number</th>
              <th className="py-1.5 pr-3 font-medium">Date</th>
              <th className="py-1.5 pr-3 font-medium">Due</th>
              <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
              <th className="py-1.5 text-right font-medium">Still to pay</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {open.map((item) => (
              <tr key={item.id}>
                <td className="py-1.5 pr-3 whitespace-nowrap">{item.number ?? "Opening balance"}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatIsoDate(item.date)}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatIsoDate(item.dueDate)}</td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">{formatAmount(item.total)}</td>
                <td className="py-1.5 text-right whitespace-nowrap tabular-nums">{formatAmount(item.outstanding)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
