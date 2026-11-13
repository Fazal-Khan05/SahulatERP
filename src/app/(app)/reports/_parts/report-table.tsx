import { formatAmount } from "@/lib/money";
import type { ReportTable } from "@/modules/reports/rules";

/**
 * A report as a table: the same rows the downloaded file and the printed page carry. Headings
 * start a section, totals are ruled off, and accounts are set in under their headings.
 */
export function ReportTableView({ table }: { table: ReportTable }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={table.title} className="w-full text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            {table.columns.map((column) => (
              <th key={column.label} scope="col" className={`py-2 pr-4 font-medium last:pr-0 ${column.numeric ? "text-right" : ""}`}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => {
            const tone =
              row.kind === "grand" ? "border-y-2 border-foreground/60 font-bold" : row.kind === "total" ? "border-t font-semibold" : row.kind === "heading" ? "font-bold" : "border-t border-border/60";
            return (
              <tr key={index} data-row={row.kind} className={tone}>
                {row.cells.map((cell, at) => (
                  <td
                    key={at}
                    className={`py-1.5 pr-4 align-top last:pr-0 ${table.columns[at]?.numeric ? "text-right whitespace-nowrap tabular-nums" : ""} ${row.kind === "heading" ? "pt-4" : ""}`}
                    style={at === 0 && row.depth > 1 ? { paddingLeft: (row.depth - 1) * 18 } : undefined}
                  >
                    {cell === null ? "" : typeof cell === "string" ? cell : formatAmount(cell)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {table.notes.map((note) => (
        <p key={note} data-testid="report-note" className="mt-3 text-sm text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}
