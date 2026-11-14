import "server-only";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { formatDateTime } from "@/lib/format";
import type { PrintView } from "./view";

// The PDF of a printed sales document: the same view as the printed page, on A4.
//
// It is drawn with the PDF's own built-in font, which has Latin letters only: a description
// written in Urdu would print as blanks. See docs/later/step-23.md.

export type PdfLogo = { bytes: Uint8Array; contentType: string };

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 36, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 2, borderBottomColor: "#111", paddingBottom: 10 },
  headerLeft: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
  logo: { height: 48, maxWidth: 140, objectFit: "contain", marginRight: 12 },
  company: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  muted: { color: "#555" },
  small: { fontSize: 8 },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginTop: 16 },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  number: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  cancelled: { marginTop: 8, padding: 6, borderWidth: 1, borderColor: "#b91c1c", color: "#b91c1c", fontFamily: "Helvetica-Bold" },
  parties: { flexDirection: "row", justifyContent: "space-between", marginTop: 14, marginBottom: 14 },
  heading: { fontSize: 8, color: "#555", textTransform: "uppercase", marginBottom: 3 },
  bold: { fontFamily: "Helvetica-Bold" },
  facts: { width: 200 },
  fact: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#111", paddingBottom: 3, fontFamily: "Helvetica-Bold" },
  tableRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#ccc", paddingVertical: 3 },
  totals: { marginTop: 6, marginLeft: "auto", width: 230 },
  total: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  strongTotal: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderTopWidth: 1, borderTopColor: "#111", fontFamily: "Helvetica-Bold" },
  words: { marginTop: 8, fontFamily: "Helvetica-Oblique" },
  notes: { marginTop: 12 },
  signatures: { flexDirection: "row", justifyContent: "space-between", marginTop: 48 },
  signature: { width: 220, borderTopWidth: 1, borderTopColor: "#111", paddingTop: 3 },
  footer: { position: "absolute", bottom: 20, left: 36, right: 36, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: "#555" },
});

/** How wide each column is: the description takes what is left. */
function columnStyle(label: string, numeric: boolean, many: boolean) {
  if (label === "Description") return { flexGrow: 1, flexBasis: 0, paddingRight: 4 };
  const width = label === "Item" ? 58 : label === "Rate" ? 32 : label === "Discount" ? 38 : many ? 52 : 64;
  return { width, paddingRight: 4, textAlign: numeric ? ("right" as const) : ("left" as const) };
}

/** react-pdf draws PNG and JPEG pictures only; a WebP logo is left off the PDF. */
function logoSource(logo: PdfLogo | null) {
  if (!logo) return null;
  if (logo.contentType === "image/png") return { data: Buffer.from(logo.bytes), format: "png" as const };
  if (logo.contentType === "image/jpeg") return { data: Buffer.from(logo.bytes), format: "jpg" as const };
  return null;
}

export function SalesDocumentPdf({ view, companyName, productName, logo, printedAt }: { view: PrintView; companyName: string; productName: string; logo: PdfLogo | null; printedAt: Date }) {
  const many = view.table.columns.length > 7;
  const source = logoSource(logo);
  return (
    <Document title={`${view.title} ${view.number}`} author={companyName} creator={productName} producer={productName}>
      <Page size="A4" style={[styles.page, many ? { fontSize: 8 } : {}]}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF picture has no alt text */}
            {source ? <Image src={source} style={styles.logo} /> : null}
            <View>
              <Text style={styles.company}>{companyName}</Text>
              {view.seller.map((line) => (
                <Text key={line} style={styles.muted}>
                  {line}
                </Text>
              ))}
            </View>
          </View>
          <Text style={[styles.muted, styles.small]}>{productName}</Text>
        </View>

        <View style={styles.titleRow}>
          <Text style={styles.title}>{view.title}</Text>
          <Text style={styles.number}>{view.number}</Text>
        </View>
        {view.cancelled !== null ? <Text style={styles.cancelled}>Cancelled{view.cancelled ? `: ${view.cancelled}` : ""}</Text> : null}

        <View style={styles.parties}>
          <View style={{ flexShrink: 1, paddingRight: 16 }}>
            <Text style={styles.heading}>{view.buyerHeading}</Text>
            {view.buyer.map((line, index) => (
              <Text key={`${index}-${line}`} style={index === 0 ? styles.bold : undefined}>
                {line}
              </Text>
            ))}
          </View>
          <View style={styles.facts}>
            {view.facts.map(([label, value]) => (
              <View key={label} style={styles.fact}>
                <Text style={styles.muted}>{label}</Text>
                <Text>{value}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.tableHead} fixed>
          {view.table.columns.map((column) => (
            <Text key={column.label} style={columnStyle(column.label, column.numeric, many)}>
              {column.label}
            </Text>
          ))}
        </View>
        {view.table.rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.tableRow} wrap={false}>
            {row.map((cell, cellIndex) => (
              <Text key={cellIndex} style={columnStyle(view.table.columns[cellIndex].label, view.table.columns[cellIndex].numeric, many)}>
                {cell}
              </Text>
            ))}
          </View>
        ))}

        {view.table.totals.length > 0 ? (
          <View style={styles.totals} wrap={false}>
            {view.table.totals.map((total) => (
              <View key={total.label} style={total.strong ? styles.strongTotal : styles.total}>
                <Text>{total.label}</Text>
                <Text>{total.amount}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {view.words ? <Text style={styles.words}>{view.words}</Text> : null}
        {view.notes ? (
          <View style={styles.notes} wrap={false}>
            <Text style={styles.heading}>Notes</Text>
            <Text>{view.notes}</Text>
          </View>
        ) : null}
        {view.signatures.length > 0 ? (
          <View style={styles.signatures} wrap={false}>
            {view.signatures.map((label) => (
              <Text key={label} style={styles.signature}>
                {label}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text>
            {view.title} {view.number} · printed {formatDateTime(printedAt)}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** The PDF's bytes. */
export async function renderSalesPdf(props: Parameters<typeof SalesDocumentPdf>[0]): Promise<Uint8Array> {
  const buffer = await renderToBuffer(<SalesDocumentPdf {...props} />);
  return new Uint8Array(buffer);
}
