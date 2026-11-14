import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime, todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getCustomerRecovery } from "@/modules/recovery/queries";
import { OVERDUE_BANDS, daysBetween } from "@/modules/recovery/rules";
import { can } from "@/modules/tenant/rules";
import { addFollowUpAction, addPromiseAction } from "../../_parts/actions";
import { PromisePill, Refused, Sections, recoveryRefusal } from "../../_parts/parts";

export const metadata: Metadata = { title: "Customer recovery" };

export default function CustomerRecoveryPage({ params }: PageProps<"/recovery/customers/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <CustomerRecovery params={params} />
    </Suspense>
  );
}

async function CustomerRecovery({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const refused = recoveryRefusal(session);
  if (refused) return <Refused title="Customer recovery" reason={refused} />;
  const { id } = await params;
  const today = todayIso(new Date());
  const page = await getCustomerRecovery(session, id, today);
  if (!page) notFound();
  const writer = can(session.role, "recovery.manage");
  return (
    <>
      <PageHead title={page.name} sub={`${formatAmount(page.ageing.total)} owed, ${formatAmount(page.ageing.overdue)} of it overdue`} />
      <Sections session={session} current={null} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card title="What is owed">
          <dl className="mb-4 grid grid-cols-5 gap-2 text-sm max-sm:grid-cols-2">
            {OVERDUE_BANDS.map((band, at) => (
              <div key={band.label}>
                <dt className="text-muted-foreground">{band.label}</dt>
                <dd className="tabular-nums">{formatAmount(page.ageing.bands[at])}</dd>
              </div>
            ))}
          </dl>
          {page.items.length === 0 ? (
            <Empty>Nothing is unpaid.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Unpaid invoices" className="w-full min-w-[520px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Number</th>
                    <th className="py-2 pr-4 font-medium">Due</th>
                    <th className="py-2 pr-4 text-right font-medium">Days late</th>
                    <th className="py-2 pr-4 text-right font-medium">Amount</th>
                    <th className="py-2 text-right font-medium">Still to pay</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {page.items.map((item) => {
                    const late = daysBetween(item.dueDate, today);
                    return (
                      <tr key={item.id}>
                        <td className="py-2 pr-4 whitespace-nowrap">{item.number ?? "Opening balance"}</td>
                        <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(item.dueDate)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{late > 0 ? late : ""}</td>
                        <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(item.total)}</td>
                        <td className="py-2 text-right whitespace-nowrap tabular-nums">{formatAmount(item.outstanding)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Link href={`/recovery/statements?customer=${page.id}`} className={buttonVariants({ variant: "outline", size: "sm", className: "mt-4" })}>
            Statement
          </Link>
        </Card>

        <Card title="Promises to pay">
          {page.promises.length === 0 ? (
            <Empty>No promise yet.</Empty>
          ) : (
            <ul aria-label="Promises to pay" className="mb-4 divide-y text-sm">
              {page.promises.map((promise) => (
                <li key={promise.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <PromisePill state={promise.state} />
                  <span className="tabular-nums">
                    {formatAmount(promise.amount)} by {formatIsoDate(promise.promisedOn)}
                  </span>
                  <span className="text-muted-foreground">
                    {formatAmount(promise.received)} arrived since {formatIsoDate(promise.madeOn)}; noted by {promise.by}
                    {promise.note ? `: ${promise.note}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {writer ? (
            <ActionForm action={addPromiseAction.bind(null, page.id)} submitLabel="Save promise" className="max-w-xl">
              <div className="flex flex-wrap gap-3">
                <Field label="Amount promised" name="amount" inputMode="decimal" required autoComplete="off" className="w-40" />
                <Field label="To pay by" name="promisedOn" type="date" min={today} required className="w-44" />
              </div>
              <Field label="Note" name="note" id="promise-note" maxLength={500} autoComplete="off" placeholder="Such as: by cheque" />
            </ActionForm>
          ) : null}
        </Card>

        <Card title="Follow-ups">
          {writer ? (
            <ActionForm action={addFollowUpAction.bind(null, page.id)} submitLabel="Save follow-up" className="mb-5 max-w-xl">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="follow-up-note">What was said</Label>
                <textarea
                  id="follow-up-note"
                  name="note"
                  required
                  maxLength={1000}
                  rows={3}
                  className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
                />
              </div>
              <Field label="Follow up again on" name="nextOn" type="date" min={today} className="w-44" />
            </ActionForm>
          ) : null}
          {page.followUps.length === 0 ? (
            <Empty>No follow-up yet.</Empty>
          ) : (
            <ol aria-label="Follow-ups" className="divide-y text-sm">
              {page.followUps.map((note) => (
                <li key={note.id} className="py-2">
                  <p className="whitespace-pre-line">{note.note}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(note.createdAt)}, {note.by}
                    {note.nextOn ? `; next on ${formatIsoDate(note.nextOn)}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
