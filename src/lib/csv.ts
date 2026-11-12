// Reads CSV text into rows of cells. No I/O.
//
// Follows RFC 4180: commas separate cells, a cell may be wrapped in double quotes, a quote inside
// a quoted cell is written twice, and a quoted cell may contain commas and line breaks. Accepts
// the byte-order mark Excel writes and any of the three line endings. Cells are returned exactly
// as written; trimming and meaning are the caller's business. An empty line is kept, as a row of
// one empty cell, so that a row's place in the result is its row number in a spreadsheet.

export type CsvResult = { ok: true; rows: string[][] } | { ok: false; reason: string };

export function parseCsv(input: string): CsvResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  // True once the current cell has closed its quotes: only a comma or a line end may follow.
  let closed = false;
  let line = 1;
  let openedAt = 0;

  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
    closed = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      closed = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
    } else if (closed) {
      return { ok: false, reason: `Line ${line} has text after a closing quote. Check the quotes in that line.` };
    } else if (ch === '"' && cell === "") {
      quoted = true;
      openedAt = line;
    } else {
      cell += ch;
    }
  }
  if (quoted) return { ok: false, reason: `A quote opened on line ${openedAt} is never closed.` };
  if (cell !== "" || row.length > 0) endRow();
  return { ok: true, rows };
}
