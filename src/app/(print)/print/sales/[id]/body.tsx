import type { PrintView } from "@/modules/sales-print/view";

/** The printed page below the letterhead. The PDF draws the same view (src/modules/sales-print/pdf.tsx). */
export function SalesPrintBody({ view }: { view: PrintView }) {
  const { columns, rows, totals } = view.table;
  return (
    <>
      {view.seller.length > 0 ? <p className="mt-2 text-sm text-muted-foreground">{view.seller.join(" · ")}</p> : null}
      <div className="mt-6 flex items-end justify-between gap-4">
        <h1 className="text-xl font-bold" data-testid="print-title">
          {view.title}
        </h1>
        <p className="font-bold tabular-nums" data-testid="print-number">
          {view.number}
        </p>
      </div>
      {view.cancelled !== null ? (
        <p className="mt-3 border border-destructive px-3 py-2 font-bold text-destructive" data-testid="print-cancelled">
          Cancelled{view.cancelled ? `: ${view.cancelled}` : ""}
        </p>
      ) : null}
      <div className="mt-5 mb-5 flex justify-between gap-8 text-sm max-sm:flex-col max-sm:gap-4">
        <div className="min-w-0">
          <p className="mb-1 text-xs text-muted-foreground uppercase">{view.buyerHeading}</p>
          {view.buyer.map((line, index) => (
            <p key={`${index}-${line}`} className={index === 0 ? "font-bold" : undefined} data-testid={index === 0 ? "print-buyer" : undefined}>
              {line}
            </p>
          ))}
        </div>
        <dl className="grid w-64 flex-none grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 max-sm:w-full">
          {view.facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="overflow-x-auto">
        <table aria-label="Lines" className="w-full text-left text-sm">
          <thead className="border-b-2 border-foreground">
            <tr>
              {columns.map((column) => (
                <th key={column.label} className={`py-1.5 pr-3 font-semibold last:pr-0 ${column.numeric ? "text-right whitespace-nowrap" : ""}`}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="break-inside-avoid">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={`py-1.5 pr-3 align-top last:pr-0 ${columns[cellIndex].numeric ? "text-right whitespace-nowrap tabular-nums" : ""}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totals.length > 0 ? (
        <dl className="mt-3 ml-auto w-72 text-sm max-sm:w-full">
          {totals.map((total) => (
            <div key={total.label} className={`flex justify-between gap-4 py-0.5 ${total.strong ? "mt-1 border-t-2 border-foreground pt-1 font-bold" : ""}`}>
              <dt>{total.label}</dt>
              <dd className="tabular-nums" data-testid={total.strong ? "print-total" : undefined}>
                {total.amount}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {view.words ? (
        <p className="mt-3 text-sm italic" data-testid="print-words">
          {view.words}
        </p>
      ) : null}
      {view.notes ? (
        <div className="mt-6 text-sm break-inside-avoid">
          <p className="mb-1 text-xs text-muted-foreground uppercase">Notes</p>
          <p className="whitespace-pre-line">{view.notes}</p>
        </div>
      ) : null}
      {view.signatures.length > 0 ? (
        <div className="mt-16 flex justify-between gap-8 text-sm break-inside-avoid">
          {view.signatures.map((label) => (
            <p key={label} className="w-64 border-t border-foreground pt-1">
              {label}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}
