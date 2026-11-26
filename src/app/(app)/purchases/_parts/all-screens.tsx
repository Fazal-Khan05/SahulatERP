import Link from "next/link";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireTenant } from "@/lib/auth/session";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { PURCHASE_KIND_LABELS, listAllPurchases, purchaseKindsFor } from "@/modules/document-lists/queries";
import { Pill, Refused, Sections } from "./screens";

// Batch A: every buying document this member may read, together, newest first.

const TITLE = "All purchases";

export async function AllPurchasesScreen({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const session = await requireTenant();
  if (!session.modules.purchasing) return <Refused title={TITLE}>Purchasing is switched off for this company.</Refused>;
  if (purchaseKindsFor(session).length === 0) return <Refused title={TITLE}>Your role does not include buying documents.</Refused>;
  const query = await searchParams;
  const search = typeof query.q === "string" ? query.q : "";
  const { rows, more } = await listAllPurchases(session, search);
  return (
    <>
      <PageHead title={TITLE} sub="Every purchase order, goods received, supplier bill, supplier payment and supplier return you can see, newest first." />
      <Sections session={session} current="/purchases/all" />
      <Card className="max-w-5xl">
        <form className="mb-3 flex max-w-sm gap-2" role="search">
          <Input name="q" defaultValue={search} placeholder="Find by number or supplier" aria-label="Find by number or supplier" />
          <button type="submit" className={buttonVariants({ variant: "outline" })}>
            Find
          </button>
        </form>
        {rows.length === 0 ? (
          <Empty>{search === "" ? "No buying documents yet." : "Nothing matches."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="All purchases" className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Supplier</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={`${row.kind}:${row.id}`}>
                    <td className="py-2 pr-4 whitespace-nowrap">{PURCHASE_KIND_LABELS[row.kind]}</td>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={row.href} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.party}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{row.amount === null ? "" : formatAmount(row.amount)}</td>
                    <td className="py-2">
                      <Pill label={row.status} strong={row.status === "Posted" || row.status === "Submitted"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200. Open one kind above to see more of it.</p> : null}
      </Card>
    </>
  );
}
