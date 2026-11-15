import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { Button, buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { canReadStatements, getCommissionStatement, listStatements } from "@/modules/commission-statements/queries";
import { monthChoices, owedToThem } from "@/modules/commission-statements/rules";
import { formatIsoDate } from "@/modules/currencies/rules";
import { readPeriod } from "@/modules/recovery/rules";
import { can } from "@/modules/tenant/rules";
import { CommissionStatementBody } from "./body";

type Search = Promise<Record<string, string | string[] | undefined>>;
const money = "py-2 pr-4 text-right whitespace-nowrap tabular-nums";

function Refused({ reason }: { reason: string }) {
  return (
    <>
      <PageHead title="Commission statements" />
      <p className="text-muted-foreground">{reason}</p>
    </>
  );
}

/** The period's form, with this month and last month a click away. */
function PeriodChooser({ period, path }: { period: { from: string; to: string }; path: string }) {
  const choices = monthChoices(todayIso(new Date()));
  const href = (p: { from: string; to: string }) => `${path}?${new URLSearchParams(p).toString()}`;
  return (
    <Card>
      <form method="get" action={path} className="flex flex-wrap items-end gap-3">
        <Field label="From" name="from" type="date" defaultValue={period.from} required />
        <Field label="To" name="to" type="date" defaultValue={period.to} required />
        <Button type="submit">Show</Button>
        <span className="flex gap-3 text-sm">
          <Link href={href(choices.thisMonth)} className="underline-offset-4 hover:underline">
            This month
          </Link>
          <Link href={href(choices.lastMonth)} className="underline-offset-4 hover:underline">
            Last month
          </Link>
        </span>
      </form>
    </Card>
  );
}

/**
 * The statements the reader may open for a period. The owner, an accountant and the auditor see
 * everyone; a manager sees themself and their team; a salesperson goes straight to their own.
 */
export async function StatementsScreen({ searchParams }: { searchParams: Search }) {
  const session = await requireTenant();
  if (!session.modules.commissions) return <Refused reason="Commissions is switched off for this company." />;
  if (!canReadStatements(session)) return <Refused reason="Your role does not include commission statements." />;
  const period = readPeriod(await searchParams, todayIso(new Date()));
  const query = new URLSearchParams(period).toString();
  const { everyone, people } = await listStatements(session, period);
  if (!everyone && people.length === 1 && people[0].userId === session.userId) redirect(`/commissions/statements/${session.userId}?${query}`);

  return (
    <>
      <PageHead title="Commission statements" sub="Each person's commission over a period: what was earned, what the customers' payments released, what was paid, and what is owed." />
      <div className="flex max-w-6xl flex-col gap-5">
        <PeriodChooser period={period} path="/commissions/statements" />
        <Card title={`${formatIsoDate(period.from)} to ${formatIsoDate(period.to)}`}>
          {people.length === 0 ? (
            <Empty>Nobody has earned commission yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Commission statements" className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Person</th>
                    <th className="py-2 pr-4 text-right font-medium">Owed brought forward</th>
                    <th className="py-2 pr-4 text-right font-medium">Earned</th>
                    <th className="py-2 pr-4 text-right font-medium">Released</th>
                    <th className="py-2 pr-4 text-right font-medium">Paid</th>
                    <th className="py-2 text-right font-medium">Owed at the end</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {people.map((person) => (
                    <tr key={person.userId}>
                      <td className="py-2 pr-4 font-medium">
                        <Link href={`/commissions/statements/${person.userId}?${query}`} className="underline-offset-4 hover:underline">
                          {person.name}
                        </Link>
                        {person.userId === session.userId ? <span className="text-muted-foreground"> (you)</span> : null}
                      </td>
                      <td className={money}>{formatAmount(owedToThem(person.opening))}</td>
                      <td className={money}>{formatAmount(person.period.earned)}</td>
                      <td className={money}>{formatAmount(person.period.released)}</td>
                      <td className={money}>{formatAmount(person.period.paid)}</td>
                      <td className="py-2 text-right whitespace-nowrap tabular-nums">{formatAmount(owedToThem(person.closing))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

/** One person's statement for a period, with its print and PDF. */
export async function StatementScreen({ params, searchParams }: { params: Promise<{ userId: string }>; searchParams: Search }) {
  const session = await requireTenant();
  if (!session.modules.commissions) return <Refused reason="Commissions is switched off for this company." />;
  if (!canReadStatements(session)) return <Refused reason="Your role does not include commission statements." />;
  const [{ userId }, raw] = await Promise.all([params, searchParams]);
  const period = readPeriod(raw, todayIso(new Date()));
  const data = await getCommissionStatement(session, userId, period);
  if (!data) notFound();
  const query = new URLSearchParams(period).toString();
  const own = userId === session.userId;

  return (
    <>
      <PageHead title={own ? "My commission statement" : `Commission statement: ${data.person.name}`} sub="Everything that happened to the commission in the period, with what is owed after each." />
      <div className="flex max-w-6xl flex-col gap-5">
        <PeriodChooser period={period} path={`/commissions/statements/${userId}`} />
        <Card title={`${data.person.name}, ${formatIsoDate(period.from)} to ${formatIsoDate(period.to)}`}>
          <div className="mb-4 flex flex-wrap gap-2">
            <Link href={`/print/commission-statement/${userId}?${query}`} className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="commission-statement-print">
              Print
            </Link>
            <a href={`/print/commission-statement/${userId}/pdf?${query}`} className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="commission-statement-pdf">
              Download PDF
            </a>
            {can(session.role, "commission.approve") ? (
              <Link href={`/commissions/earned?person=${userId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Approve and pay
              </Link>
            ) : null}
            <Link href={`/commissions/statements?${query}`} className="ml-auto self-center text-sm text-muted-foreground underline-offset-4 hover:underline">
              All statements
            </Link>
          </div>
          <CommissionStatementBody data={data} linkInvoices={can(session.role, "sales.read")} />
        </Card>
      </div>
    </>
  );
}
