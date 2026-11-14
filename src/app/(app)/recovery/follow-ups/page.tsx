import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listFollowUpsDue, listPromises } from "@/modules/recovery/queries";
import { PromisePill, Refused, Sections, recoveryRefusal } from "../_parts/parts";

export const metadata: Metadata = { title: "Follow-ups" };

export default function FollowUpsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <FollowUps />
    </Suspense>
  );
}

async function FollowUps() {
  const session = await requireTenant();
  const refused = recoveryRefusal(session);
  if (refused) return <Refused title="Follow-ups" reason={refused} />;
  const today = todayIso(new Date());
  const [due, promises] = await Promise.all([listFollowUpsDue(session, today), listPromises(session, today)]);
  const broken = promises.filter((promise) => promise.state === "broken");
  const waiting = promises.filter((promise) => promise.state === "waiting").sort((a, b) => a.promisedOn.localeCompare(b.promisedOn));
  const customer = (id: string, name: string) => (
    <Link href={`/recovery/customers/${id}`} className="font-medium underline-offset-4 hover:underline">
      {name}
    </Link>
  );
  return (
    <>
      <PageHead title="Follow-ups and promises" sub="Who to call today, and what customers promised." />
      <Sections session={session} current="/recovery/follow-ups" />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card title="To follow up today">
          {due.length === 0 ? (
            <Empty>Nobody is due a follow-up today.</Empty>
          ) : (
            <ul aria-label="To follow up today" className="divide-y text-sm">
              {due.map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  {customer(row.customerId, row.customerName)}
                  <span className="text-muted-foreground">
                    due {formatIsoDate(row.nextOn!)}: last time, {row.by} wrote &ldquo;{row.note}&rdquo;
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Broken promises">
          {broken.length === 0 ? (
            <Empty>No promise has been broken.</Empty>
          ) : (
            <PromiseTable label="Broken promises" rows={broken} customer={customer} />
          )}
        </Card>
        <Card title="Promises still to come">
          {waiting.length === 0 ? <Empty>No promise is waiting.</Empty> : <PromiseTable label="Promises still to come" rows={waiting} customer={customer} />}
        </Card>
      </div>
    </>
  );
}

function PromiseTable({ label, rows, customer }: { label: string; rows: Awaited<ReturnType<typeof listPromises>>; customer: (id: string, name: string) => React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[560px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Customer</th>
            <th className="py-2 pr-4 text-right font-medium">Promised</th>
            <th className="py-2 pr-4 font-medium">By</th>
            <th className="py-2 pr-4 text-right font-medium">Arrived since</th>
            <th className="py-2 font-medium">State</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="py-2 pr-4">{customer(row.customerId, row.customerName)}</td>
              <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(row.amount)}</td>
              <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.promisedOn)}</td>
              <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(row.received)}</td>
              <td className="py-2">
                <PromisePill state={row.state} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
