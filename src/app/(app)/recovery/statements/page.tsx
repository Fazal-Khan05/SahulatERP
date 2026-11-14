import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { findRecoveryCustomers, getCustomerStatement } from "@/modules/recovery/queries";
import { readPeriod } from "@/modules/recovery/rules";
import { mailSenderFromEnvironment } from "@/modules/sales-email/sender";
import { Refused, Sections, StatementBody, recoveryRefusal } from "../_parts/parts";

export const metadata: Metadata = { title: "Customer statements" };

export default function StatementsPage({ searchParams }: PageProps<"/recovery/statements">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Statements searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

async function Statements({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const refused = recoveryRefusal(session);
  if (refused) return <Refused title="Customer statements" reason={refused} />;
  const raw = await searchParams;
  const today = todayIso(new Date());
  const period = readPeriod(raw, today);
  const customerId = one(raw.customer);
  const search = one(raw.q);
  const [found, data] = await Promise.all([customerId ? [] : findRecoveryCustomers(session, search), customerId ? getCustomerStatement(session, customerId, period) : null]);
  const query = (extra: Record<string, string> = {}) => new URLSearchParams({ from: period.from, to: period.to, ...extra }).toString();

  return (
    <>
      <PageHead title="Customer statements" sub="A customer's invoices and payments over a period, with the balance after each, read from the books." />
      <Sections session={session} current="/recovery/statements" />
      <div className="flex max-w-5xl flex-col gap-5">
        {data ? (
          <>
            <Card>
              <form method="get" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="customer" value={data.customer.id} />
                <Field label="From" name="from" type="date" defaultValue={period.from} required />
                <Field label="To" name="to" type="date" defaultValue={period.to} required />
                <Button type="submit">Show</Button>
                <Link href="/recovery/statements" className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:underline">
                  Another customer
                </Link>
              </form>
            </Card>
            <Card title={`${data.customer.name}${data.customer.code ? ` (${data.customer.code})` : ""}`}>
              <div className="mb-4 flex flex-wrap gap-2">
                <Link href={`/print/statement/${data.customer.id}?${query()}`} className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="statement-print">
                  Print
                </Link>
                <a href={`/print/statement/${data.customer.id}/pdf?${query()}`} className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="statement-pdf">
                  Download PDF
                </a>
              </div>
              {mailSenderFromEnvironment() === null ? (
                <p className="mb-4 text-sm text-muted-foreground" data-testid="email-not-set-up">
                  Email is not set up yet: the email service has not been chosen. Until it is, download the PDF and send it yourself.
                </p>
              ) : null}
              <StatementBody data={data} />
            </Card>
          </>
        ) : (
          <Card title="Choose a customer">
            <form method="get" role="search" className="mb-3 flex max-w-md gap-2">
              <Input name="q" defaultValue={search} placeholder="Customer name or code" aria-label="Customer name or code" />
              <Button type="submit" variant="outline">
                Find
              </Button>
            </form>
            {found.length === 0 ? (
              <Empty>No customer matches.</Empty>
            ) : (
              <ul aria-label="Customers" className="divide-y text-sm">
                {found.map((customer) => (
                  <li key={customer.id} className="py-2">
                    <Link href={`/recovery/statements?${query({ customer: customer.id })}`} className="font-medium underline-offset-4 hover:underline">
                      {customer.name}
                    </Link>
                    {customer.code ? <span className="text-muted-foreground"> {customer.code}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
