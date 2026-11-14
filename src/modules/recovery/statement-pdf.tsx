import "server-only";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { formatDateTime } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import type { CustomerStatement } from "./queries";

// The PDF of a customer statement: the same as the printed page, on A4, in the PDF's built-in
// font (Latin letters only, as for sales documents; see docs/later/step-23.md).

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 36, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 2, borderBottomColor: "#111", paddingBottom: 10 },
  headerLeft: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
  logo: { height: 48, maxWidth: 140, objectFit: "contain", marginRight: 12 },
  company: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  muted: { color: "#555" },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginTop: 16, marginBottom: 10 },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  bold: { fontFamily: "Helvetica-Bold" },
  head: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#111", paddingBottom: 3, marginTop: 12, fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#ccc", paddingVertical: 3 },
  foot: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#111", paddingVertical: 3, fontFamily: "Helvetica-Bold" },
  heading: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 18 },
  footer: { position: "absolute", bottom: 20, left: 36, right: 36, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: "#555" },
});

const col = { date: { width: 62 }, what: { flexGrow: 1, flexBasis: 0, paddingRight: 4 }, number: { width: 88 }, amount: { width: 70, textAlign: "right" as const } };
const balance = (amount: CustomerStatement["statement"]["closing"]) => (amount.isNegative() ? `${formatAmount(amount.abs())} CR` : formatAmount(amount));

/** react-pdf draws PNG and JPEG pictures only; a WebP logo is left off. */
function logoSource(logo: { bytes: Uint8Array; contentType: string } | null) {
  if (logo?.contentType === "image/png") return { data: Buffer.from(logo.bytes), format: "png" as const };
  if (logo?.contentType === "image/jpeg") return { data: Buffer.from(logo.bytes), format: "jpg" as const };
  return null;
}

function StatementPdf({ data, companyName, productName, logo, printedAt }: { data: CustomerStatement; companyName: string; productName: string; logo: { bytes: Uint8Array; contentType: string } | null; printedAt: Date }) {
  const source = logoSource(logo);
  const { statement } = data;
  return (
    <Document title={`Statement ${data.customer.name} ${data.from} to ${data.to}`} author={companyName} creator={productName} producer={productName}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF picture has no alt text */}
            {source ? <Image src={source} style={styles.logo} /> : null}
            <Text style={styles.company}>{companyName}</Text>
          </View>
          <Text style={styles.muted}>{productName}</Text>
        </View>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Statement of account</Text>
          <Text>
            {formatIsoDate(data.from)} to {formatIsoDate(data.to)}
          </Text>
        </View>
        <Text style={styles.bold}>{data.customer.name}</Text>
        {data.customer.address ? <Text>{data.customer.address}</Text> : null}
        {data.customer.ntn ? <Text>NTN {data.customer.ntn}</Text> : null}

        <View style={styles.head} fixed>
          <Text style={col.date}>Date</Text>
          <Text style={col.what}>What</Text>
          <Text style={col.number}>Number</Text>
          <Text style={col.amount}>Charged</Text>
          <Text style={col.amount}>Paid</Text>
          <Text style={col.amount}>Balance</Text>
        </View>
        <View style={styles.row}>
          <Text style={col.date}>{formatIsoDate(data.from)}</Text>
          <Text style={col.what}>Balance brought forward</Text>
          <Text style={col.number} />
          <Text style={col.amount} />
          <Text style={col.amount} />
          <Text style={col.amount}>{balance(statement.opening)}</Text>
        </View>
        {statement.rows.map((row, index) => (
          <View key={index} style={styles.row} wrap={false}>
            <Text style={col.date}>{formatIsoDate(row.date)}</Text>
            <Text style={col.what}>{row.what}</Text>
            <Text style={col.number}>{row.number ?? ""}</Text>
            <Text style={col.amount}>{row.debit.isZero() ? "" : formatAmount(row.debit)}</Text>
            <Text style={col.amount}>{row.credit.isZero() ? "" : formatAmount(row.credit)}</Text>
            <Text style={col.amount}>{balance(row.balance)}</Text>
          </View>
        ))}
        <View style={styles.foot} wrap={false}>
          <Text style={col.date} />
          <Text style={col.what}>Balance on {formatIsoDate(data.to)}</Text>
          <Text style={col.number} />
          <Text style={col.amount}>{formatAmount(statement.debits)}</Text>
          <Text style={col.amount}>{formatAmount(statement.credits)}</Text>
          <Text style={col.amount}>{balance(statement.closing)}</Text>
        </View>

        <Text style={styles.heading}>Unpaid invoices today</Text>
        {data.open.length === 0 ? <Text>Nothing is unpaid.</Text> : null}
        {data.open.map((item) => (
          <View key={item.id} style={styles.row} wrap={false}>
            <Text style={col.number}>{item.number ?? "Opening balance"}</Text>
            <Text style={col.what}>
              dated {formatIsoDate(item.date)}, due {formatIsoDate(item.dueDate)}
            </Text>
            <Text style={col.amount}>{formatAmount(item.total)}</Text>
            <Text style={col.amount}>{formatAmount(item.outstanding)}</Text>
          </View>
        ))}

        <View style={styles.footer} fixed>
          <Text>
            Statement for {data.customer.name} · printed {formatDateTime(printedAt)}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** The PDF's bytes. */
export async function renderStatementPdf(props: Parameters<typeof StatementPdf>[0]): Promise<Uint8Array> {
  return new Uint8Array(await renderToBuffer(<StatementPdf {...props} />));
}

/** The file's name: the customer's code or "statement", and the period. Only letters, digits and dashes. */
export function statementFileName(data: Pick<CustomerStatement, "customer" | "from" | "to">): string {
  const who = (data.customer.code ?? "statement").replace(/[^A-Za-z0-9-]/g, "") || "statement";
  return `${who}-${data.from}-to-${data.to}.pdf`;
}
