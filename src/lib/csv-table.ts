import { parseCsv } from "./csv";

// Reads a CSV file whose first row names its columns. No I/O.
//
// Rows are numbered as a spreadsheet shows them: the heading is row 1 when nothing is above it,
// and empty rows still count. What a cell means is the caller's business.

export type CsvColumn<K extends string> = { key: K; header: string };

export type CsvTable<K extends string> =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** One entry per row that has anything in it. `extra` says the row has cells beyond the last column. */
      rows: { row: number; raw: Partial<Record<K, string>>; extra: boolean }[];
    };

const plain = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const blank = (value: string): boolean => value.replace(/[\s\u200b-\u200d\u2060\ufeff]/g, "") === "";

export function readCsvTable<K extends string>(csv: string, columns: readonly CsvColumn<K>[], needs: K, maxRows: number): CsvTable<K> {
  // Bytes that are not UTF-8 arrive as this character; importing them would store garbled text.
  if (csv.includes("\ufffd")) {
    return { ok: false, reason: 'The file is not saved as UTF-8. In Excel, save it as "CSV UTF-8 (Comma delimited)" and import it again.' };
  }
  const parsed = parseCsv(csv);
  if (!parsed.ok) return parsed;
  const filled = (cells: string[]) => cells.some((cell) => !blank(cell));
  const headingAt = parsed.rows.findIndex(filled);
  if (headingAt === -1) return { ok: false, reason: "The file is empty." };
  // A spreadsheet that once had more columns leaves empty cells at the end of every row.
  const headings = [...parsed.rows[headingAt]];
  while (headings.length > 0 && blank(headings[headings.length - 1])) headings.pop();

  const keys: K[] = [];
  for (const heading of headings) {
    const column = columns.find((c) => plain(c.header) === plain(heading) || plain(c.key) === plain(heading));
    if (!column) return { ok: false, reason: `The column "${heading.trim().slice(0, 40)}" is not one this import knows. Rename or remove it.` };
    if (keys.includes(column.key)) return { ok: false, reason: `The column "${column.header}" is in the file twice.` };
    keys.push(column.key);
  }
  const needed = columns.find((c) => c.key === needs);
  if (!keys.includes(needs)) return { ok: false, reason: `The file needs a "${needed?.header ?? needs}" column in its first row.` };

  const rows = parsed.rows
    .map((cells, index) => ({ cells, row: index + 1 }))
    .filter(({ cells, row }) => row > headingAt + 1 && filled(cells));
  if (rows.length === 0) return { ok: false, reason: "The file has a heading row but no rows under it." };
  if (rows.length > maxRows) return { ok: false, reason: `The file has ${rows.length} rows. Import at most ${maxRows} at a time.` };

  return {
    ok: true,
    rows: rows.map(({ cells, row }) => ({
      row,
      raw: Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? ""])) as Partial<Record<K, string>>,
      extra: filled(cells.slice(keys.length)),
    })),
  };
}
