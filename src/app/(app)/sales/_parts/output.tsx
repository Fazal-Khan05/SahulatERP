import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { TenantSession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getCustomerEmail } from "@/modules/sales-email/queries";
import { defaultEmail } from "@/modules/sales-email/rules";
import { mailSenderFromEnvironment } from "@/modules/sales-email/sender";
import { printable, printTitle, showsPrices } from "@/modules/sales-print/rules";
import { getTimeline } from "@/modules/sales-timeline/queries";
import type { SalesDocument } from "@/modules/sales/queries";
import { can } from "@/modules/tenant/rules";
import { emailSalesAction, settleEmailAction } from "./output-actions";

type Document = SalesDocument & { madeFrom: { kind: SalesDocument["kind"]; number: string | null }[] };

/**
 * Step 23 on a sales document's page: print it, download its PDF, email it to the customer, and
 * what has happened to it so far.
 */
export async function DocumentOutput({ session, document }: { session: TenantSession; document: Document }) {
  const numbered = document.number !== null && printable(document.status);
  const emailer = numbered && document.status === "submitted" && can(session.role, "sales.email");
  const [events, customerEmail] = await Promise.all([getTimeline(session, document), emailer ? getCustomerEmail(session, document.customerId) : null]);
  const sender = emailer ? mailSenderFromEnvironment() : null;
  const settler = can(session.role, "sales.email");
  const title = printTitle(document.kind, document.taxed);
  const draft =
    emailer && document.number
      ? defaultEmail({
          title,
          number: document.number,
          date: formatIsoDate(document.date),
          companyName: session.tenantName,
          customerName: document.customerName,
          total: showsPrices(document.kind) ? `${document.currency} ${formatAmount(document.totals.total)}` : null,
        })
      : null;

  return (
    <>
      {numbered ? (
        <Card title="Print and send">
          <div className="flex flex-wrap gap-2">
            <Link href={`/print/sales/${document.id}`} className={buttonVariants({ variant: "outline" })} data-testid="print-link">
              Print
            </Link>
            <a href={`/print/sales/${document.id}/pdf`} className={buttonVariants({ variant: "outline" })} data-testid="pdf-link">
              Download PDF
            </a>
          </div>
          {emailer && draft ? (
            <div className="mt-5 border-t pt-4">
              <h3 className="mb-1 font-semibold">Email to the customer</h3>
              {sender ? (
                <p className="mb-3 text-sm text-muted-foreground">The PDF goes with it. Answers come back to {session.email}.</p>
              ) : (
                <p className="mb-3 text-sm text-muted-foreground" data-testid="email-not-set-up">
                  Email is not set up yet: the email service has not been chosen. Until it is, download the PDF and send it yourself.
                </p>
              )}
              {sender ? (
                <ActionForm action={emailSalesAction.bind(null, document.id)} submitLabel="Send email" className="max-w-xl">
                  <Field label="To" name="to" type="email" defaultValue={customerEmail ?? ""} required maxLength={254} autoComplete="off" />
                  <Field label="Subject" name="subject" defaultValue={draft.subject} required maxLength={200} autoComplete="off" />
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="message">Message</Label>
                    <textarea
                      id="message"
                      name="message"
                      defaultValue={draft.message}
                      required
                      maxLength={4000}
                      rows={7}
                      className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
                    />
                  </div>
                </ActionForm>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title="What happened">
        <ol aria-label="What happened" className="flex flex-col gap-3 text-sm">
          {events.map((event, index) => (
            <li key={index} className={`flex flex-col gap-0.5 border-l-2 pl-3 ${event.tone === "good" ? "border-primary" : event.tone === "warn" ? "border-amber-600" : "border-border"}`}>
              <span>
                {event.what}
                {event.link ? (
                  <>
                    {": "}
                    <Link href={event.link.href} className="font-medium underline underline-offset-4">
                      {event.link.label}
                    </Link>
                  </>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(event.at)}
                {event.who ? `, ${event.who}` : ""}
              </span>
              {event.unsettledEmailId && settler ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  <ActionForm action={settleEmailAction.bind(null, event.unsettledEmailId, true)} submitLabel="It arrived" compact />
                  <ActionForm action={settleEmailAction.bind(null, event.unsettledEmailId, false)} submitLabel="It did not arrive" compact />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
