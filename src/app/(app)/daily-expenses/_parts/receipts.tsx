import { Card } from "@/components/page-parts";
import type { requireTenant } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { listReceipts } from "@/modules/daily-expenses/queries";
import { FILE_MAX_BYTES, FILE_TYPES, formatBytes } from "@/modules/files/rules";
import { can } from "@/modules/tenant/rules";
import { attachReceiptAction } from "./actions";
import { ReceiptForm } from "./receipt-form";

type Session = Awaited<ReturnType<typeof requireTenant>>;

const KIND: Record<string, string> = { "application/pdf": "PDF", "image/png": "Photo (PNG)", "image/jpeg": "Photo (JPEG)", "image/webp": "Photo (WebP)" };
export const RECEIPT_TYPES = FILE_TYPES.join(",");

/** The receipts kept with an expense, each opened through a link good for one minute, and, for the owner and an accountant, the way to add one. */
export async function ReceiptsCard({ session, expenseId }: { session: Session; expenseId: string }) {
  const receipts = await listReceipts(session, expenseId);
  const keeper = can(session.role, "cash_bank.manage");
  if (receipts.length === 0 && !keeper) return null;
  return (
    <Card title="Receipts">
      <div className="flex flex-col gap-4" data-testid="receipts">
        {receipts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No receipt is kept with this expense yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {receipts.map((receipt) => (
              <li key={receipt.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                {/* A plain link, not a client-side navigation: it answers with a redirect to the file. */}
                <a href={`/daily-expenses/receipts/${receipt.id}`} className="font-semibold text-primary hover:underline">
                  {receipt.name}
                </a>
                <span className="text-muted-foreground">
                  {KIND[receipt.contentType] ?? receipt.contentType}, {formatBytes(receipt.sizeBytes)}, added {formatDateTime(receipt.addedAt)}
                  {receipt.addedBy ? ` by ${receipt.addedBy}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {keeper && receipts.length < 10 ? <ReceiptForm action={attachReceiptAction.bind(null, expenseId)} maxReceiptBytes={FILE_MAX_BYTES} receiptTypes={RECEIPT_TYPES} /> : null}
      </div>
    </Card>
  );
}
