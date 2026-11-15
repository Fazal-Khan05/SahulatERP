import "server-only";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type Decimal from "decimal.js";
import { formatDateTime } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import type { CommissionStatementData } from "./queries";
import { owedToThem, waitingForCustomers } from "./rules";

// The PDF of a commission statement: the same as the printed page, on A4, in the PDF's built-in
// font (Latin letters only, as for sales documents; see docs/later/step-23.md).

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 36,
    fontSize: 8.5,
    fontFamily: "Helvetica",
    color: "#111",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "#111",
    paddingBottom: 10,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
  logo: { height: 48, maxWidth: 140, objectFit: "contain", marginRight: 12 },
  company: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  muted: { color: "#555" },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 16,
    marginBottom: 10,
  },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  bold: { fontFamily: "Helvetica-Bold" },
  head: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#111",
    paddingBottom: 3,
    marginTop: 12,
    fontFamily: "Helvetica-Bold",
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#ccc",
    paddingVertical: 3,
  },
  foot: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#111",
    paddingVertical: 3,
    fontFamily: "Helvetica-Bold",
  },
  summary: { marginTop: 16, width: 260, alignSelf: "flex-end" },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  note: { marginTop: 12, color: "#555" },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 36,
    right: 36,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: "#555",
  },
});

const col = {
  date: { width: 54 },
  number: { width: 76 },
  what: { flexGrow: 1, flexBasis: 0, paddingRight: 4 },
  amount: { width: 58, textAlign: "right" as const },
};
const cell = (amount: Decimal) => (amount.isZero() ? "" : formatAmount(amount));

/** react-pdf draws PNG and JPEG pictures only; a WebP logo is left off. */
function logoSource(logo: { bytes: Uint8Array; contentType: string } | null) {
  if (logo?.contentType === "image/png") return { data: Buffer.from(logo.bytes), format: "png" as const };
  if (logo?.contentType === "image/jpeg") return { data: Buffer.from(logo.bytes), format: "jpg" as const };
  return null;
}

type Props = {
  data: CommissionStatementData;
  companyName: string;
  productName: string;
  logo: { bytes: Uint8Array; contentType: string } | null;
  printedAt: Date;
};

function CommissionStatementPdf({ data, companyName, productName, logo, printedAt }: Props) {
  const source = logoSource(logo);
  const { statement, person } = data;
  const owed = owedToThem(statement.closing);
  return (
    <Document title={`Commission statement ${person.name} ${data.from} to ${data.to}`} author={companyName} creator={productName} producer={productName}>
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
          <Text style={styles.title}>Commission statement</Text>
          <Text>
            {formatIsoDate(data.from)} to {formatIsoDate(data.to)}
          </Text>
        </View>
        <Text style={styles.bold}>{person.name}</Text>

        <View style={styles.head} fixed>
          <Text style={col.date}>Date</Text>
          <Text style={col.number}>Number</Text>
          <Text style={col.what}>What</Text>
          <Text style={col.amount}>Earned</Text>
          <Text style={col.amount}>Released</Text>
          <Text style={col.amount}>Paid</Text>
          <Text style={col.amount}>Owed</Text>
        </View>
        <View style={styles.row}>
          <Text style={col.date}>{formatIsoDate(data.from)}</Text>
          <Text style={col.number} />
          <Text style={col.what}>Brought forward</Text>
          <Text style={col.amount} />
          <Text style={col.amount} />
          <Text style={col.amount} />
          <Text style={col.amount}>{formatAmount(owedToThem(statement.opening))}</Text>
        </View>
        {statement.lines.map((line, index) => (
          <View key={index} style={styles.row} wrap={false}>
            <Text style={col.date}>{formatIsoDate(line.date)}</Text>
            <Text style={col.number}>{line.number ?? ""}</Text>
            <View style={col.what}>
              <Text>{line.what}</Text>
              {line.customerName || line.teamMember ? <Text style={styles.muted}>{[line.customerName, line.teamMember ? `sold by ${line.teamMember}` : null].filter(Boolean).join(", ")}</Text> : null}
            </View>
            <Text style={col.amount}>{cell(line.earned)}</Text>
            <Text style={col.amount}>{cell(line.released)}</Text>
            <Text style={col.amount}>{cell(line.paid)}</Text>
            <Text style={col.amount}>{formatAmount(line.balance)}</Text>
          </View>
        ))}
        <View style={styles.foot} wrap={false}>
          <Text style={col.date} />
          <Text style={col.number} />
          <Text style={col.what}>For the period</Text>
          <Text style={col.amount}>{formatAmount(statement.period.earned)}</Text>
          <Text style={col.amount}>{formatAmount(statement.period.released)}</Text>
          <Text style={col.amount}>{formatAmount(statement.period.paid)}</Text>
          <Text style={col.amount}>{formatAmount(owed)}</Text>
        </View>

        <View style={styles.summary} wrap={false}>
          <Text style={styles.bold}>On {formatIsoDate(data.to)}</Text>
          <View style={styles.summaryRow}>
            <Text>Earned in all</Text>
            <Text>{formatAmount(statement.closing.earned)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text>Waiting for customers to pay</Text>
            <Text>{formatAmount(waitingForCustomers(statement.closing))}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text>Released by customers&apos; payments</Text>
            <Text>{formatAmount(statement.closing.released)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text>Paid</Text>
            <Text>{formatAmount(statement.closing.paid)}</Text>
          </View>
          <View style={[styles.summaryRow, styles.bold]}>
            <Text>{owed.isNegative() ? "Owed back, from the next payment" : "Owed, to be paid"}</Text>
            <Text>{formatAmount(owed.abs())}</Text>
          </View>
        </View>
        <Text style={styles.note}>
          Commission is earned when an invoice is posted, released as the customer pays (a cheque when it clears), and taken back when goods are returned or a payment is undone. Released commission is paid once the owner
          or an accountant approves it.
        </Text>

        <View style={styles.footer} fixed>
          <Text>
            Commission statement for {person.name} · printed {formatDateTime(printedAt)}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** The PDF's bytes. */
export async function renderCommissionStatementPdf(props: Props): Promise<Uint8Array> {
  return new Uint8Array(await renderToBuffer(<CommissionStatementPdf {...props} />));
}
