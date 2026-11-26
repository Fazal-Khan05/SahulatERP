import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getImportState, type ImportState } from "@/modules/data-import/queries";
import { DATA_IMPORT_KINDS, IMPORT_KINDS, type DataImportKind } from "@/modules/data-import/rules";
import { MODULE_INFO, can } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "Import data" };

export default function ImportDataPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ImportData />
    </Suspense>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** What is in place now for each kind, in a few words. */
function inPlace(kind: DataImportKind, state: ImportState): string {
  const { counts, stock, opening } = state;
  switch (kind) {
    case "customers":
      return plural(counts.customers, "customer", "customers");
    case "suppliers":
      return plural(counts.suppliers, "supplier", "suppliers");
    case "items":
      return plural(counts.items, "item", "items");
    case "opening_stock":
      return stock.lines === 0 ? "No opening stock yet" : `${plural(stock.lines, "line", "lines")} of opening stock: ${plural(stock.posted, "posting", "postings")} done, ${plural(stock.drafts, "draft", "drafts")} to post`;
    case "customer_balances":
      return plural(opening.receivable, "unpaid invoice", "unpaid invoices");
    case "supplier_balances":
      return plural(opening.payable, "unpaid bill", "unpaid bills");
    case "ledger_balances":
      return plural(opening.account, "account balance", "account balances");
  }
}

async function ImportData() {
  const session = await requireTenant();
  if (!can(session.role, "opening.manage")) {
    return <p className="text-muted-foreground">Only an owner or an accountant can import a company&apos;s data.</p>;
  }
  const state = await getImportState(session);
  const openingWords =
    state.opening.status === "none"
      ? "not started"
      : state.opening.status === "draft"
        ? `a draft, dated ${formatIsoDate(state.opening.date ?? "")}`
        : `posted, dated ${formatIsoDate(state.opening.date ?? "")}`;

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <section className="flex flex-col gap-2 text-sm">
        <p>
          Bringing your company in from the system it used before, whatever it was: save each list from it as an Excel or CSV file, and import the files
          here, in this order. Each file is checked row by row before anything is kept, and goes in whole or not at all. The same rows never go in twice.
        </p>
        <p className="text-muted-foreground">
          Every kind has a template with our headings, but your old system&apos;s own export will do: you match its columns to ours, and the match is
          remembered for its next file. Opening balances (step 5 onwards) go onto the opening entry, which is {openingWords}:{" "}
          <Link href="/settings/opening-balances" className="underline">
            Opening balances
          </Link>
          .
        </p>
      </section>

      <ol className="flex flex-col gap-4">
        {DATA_IMPORT_KINDS.map((kind, index) => {
          const about = IMPORT_KINDS[kind];
          const last = state.history.find((record) => record.kind === kind);
          const closed = about.module && !session.modules[about.module] ? `${MODULE_INFO[about.module].label} is switched off for this company.` : !can(session.role, about.permission) ? `Your role cannot import ${about.many}.` : null;
          const notYet = about.opening && state.opening.status !== "draft" ? (state.opening.status === "none" ? "Start the opening entry first, under Opening balances." : "The opening balances are posted. Reverse them under Opening balances to add to them.") : null;
          return (
            <li key={kind}>
              <Card title={`${index + 1}. ${about.title}`}>
                <div className="flex flex-col gap-2 text-sm" data-testid={`import-${kind}`}>
                  <p>{about.about}</p>
                  {about.before ? <p className="text-muted-foreground">{about.before}</p> : null}
                  <p>
                    <span className="font-medium">Now: </span>
                    {inPlace(kind, state)}.
                    {last ? ` Last imported ${last.on}: ${last.fileName}, ${plural(last.rows, "row", "rows")}.` : ""}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {closed || notYet ? (
                      <span className="text-muted-foreground">{closed ?? notYet}</span>
                    ) : (
                      <Link href={`/settings/import/${kind}`} className={buttonVariants({ size: "sm" })}>
                        Import {about.title.toLowerCase()}
                      </Link>
                    )}
                    <span className="text-muted-foreground">Template:</span>
                    <a href={`/settings/import/${kind}/template?format=xlsx`} className="underline">
                      Excel
                    </a>
                    <a href={`/settings/import/${kind}/template?format=csv`} className="underline">
                      CSV
                    </a>
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>

      <Card title="8. Check what came in">
        <div className="flex flex-col gap-2 text-sm">
          <p>The trial balance, and whether stock, what customers owe and what you owe suppliers agree with their accounts in the books.</p>
          <Link href="/settings/import/check" className={`${buttonVariants({ size: "sm", variant: "outline" })} self-start`}>
            Check the figures
          </Link>
        </div>
      </Card>

      <Card title="Imported so far">
        {state.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been imported here yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Imported so far" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">On</th>
                  <th className="py-2 pr-4 font-medium">What</th>
                  <th className="py-2 pr-4 font-medium">File</th>
                  <th className="py-2 pr-4 text-right font-medium">Rows</th>
                  <th className="py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {state.history.map((record) => (
                  <tr key={record.id}>
                    <td className="py-2 pr-4 whitespace-nowrap">{record.on}</td>
                    <td className="py-2 pr-4">{IMPORT_KINDS[record.kind].title}</td>
                    <td className="py-2 pr-4 break-all">{record.fileName}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{record.rows.toLocaleString("en")}</td>
                    <td className="py-2">{record.by ?? "a member"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
