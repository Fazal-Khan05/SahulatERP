import "server-only";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type Decimal from "decimal.js";
import { formatDateTime } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import type { PayslipRow, RunDetail } from "./queries";
import { RUN_STATUS_LABELS } from "./rules";

// The PDF of a payslip, on A4, in the PDF's built-in font (Latin letters only, as for sales
// documents; see docs/later/step-23.md). Sent by email when the email service is built.

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
  columns: { flexDirection: "row", gap: 18, marginTop: 12 },
  column: { flexGrow: 1, flexBasis: 0 },
  heading: { fontFamily: "Helvetica-Bold", borderBottomWidth: 1, borderBottomColor: "#111", paddingBottom: 3, marginBottom: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 0.5, borderBottomColor: "#ccc", paddingVertical: 3 },
  total: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, fontFamily: "Helvetica-Bold" },
  net: { flexDirection: "row", justifyContent: "space-between", marginTop: 14, padding: 8, borderWidth: 1, borderColor: "#111", fontSize: 12, fontFamily: "Helvetica-Bold" },
  note: { marginTop: 12, color: "#555" },
  footer: { position: "absolute", bottom: 20, left: 36, right: 36, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: "#555" },
});

/** react-pdf draws PNG and JPEG pictures only; a WebP logo is left off. */
function logoSource(logo: { bytes: Uint8Array; contentType: string } | null) {
  if (logo?.contentType === "image/png") return { data: Buffer.from(logo.bytes), format: "png" as const };
  if (logo?.contentType === "image/jpeg") return { data: Buffer.from(logo.bytes), format: "jpg" as const };
  return null;
}

const monthName = (month: string) => new Date(`${month}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function Lines({ title, lines, total }: { title: string; lines: { label: string; amount: Decimal }[]; total: Decimal }) {
  return (
    <View style={styles.column}>
      <Text style={styles.heading}>{title}</Text>
      {lines.length === 0 ? (
        <View style={styles.row}>
          <Text style={styles.muted}>None</Text>
        </View>
      ) : (
        lines.map((line, index) => (
          <View key={index} style={styles.row}>
            <Text>{line.label}</Text>
            <Text>{formatAmount(line.amount)}</Text>
          </View>
        ))
      )}
      <View style={styles.total}>
        <Text>Total</Text>
        <Text>{formatAmount(total)}</Text>
      </View>
    </View>
  );
}

type Props = {
  run: Omit<RunDetail, "payslips">;
  payslip: PayslipRow;
  companyName: string;
  productName: string;
  logo: { bytes: Uint8Array; contentType: string } | null;
  printedAt: Date;
};

function PayslipPdf({ run, payslip: slip, companyName, productName, logo, printedAt }: Props) {
  const source = logoSource(logo);
  const of = (kind: string) => slip.lines.filter((line) => line.kind === kind);
  const days = slip.payBasis === "daily" ? `${slip.daysWorked.toFixed()} days worked` : `${slip.daysWorked.toFixed()} of ${slip.daysInMonth} days paid${slip.unpaidDays.gt(0) ? `, ${slip.unpaidDays.toFixed()} unpaid` : ""}`;
  return (
    <Document title={`Payslip ${slip.code} ${monthName(run.month)}`} author={companyName} creator={productName} producer={productName}>
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
          <Text style={styles.title}>Payslip for {monthName(run.month)}</Text>
          <Text>{run.number ?? RUN_STATUS_LABELS[run.status]}</Text>
        </View>
        <Text style={styles.bold}>
          {slip.name} ({slip.code})
        </Text>
        {slip.designation ? <Text>{slip.designation}</Text> : null}
        <Text style={styles.muted}>{days}</Text>

        <View style={styles.columns}>
          <Lines title="Pay" lines={of("earning")} total={slip.earnings.plus(slip.commission)} />
          <Lines title="Deductions" lines={of("deduction")} total={slip.tax.plus(slip.eobiEmployee).plus(slip.deductions)} />
        </View>
        <View style={styles.net}>
          <Text>Take home</Text>
          <Text>{formatAmount(slip.net)}</Text>
        </View>

        <View style={styles.columns}>
          <Lines title="Paid by the employer on top" lines={of("employer")} total={slip.employerEobi.plus(slip.employerSocialSecurity)} />
          <View style={styles.column}>
            <Text style={styles.heading}>Income tax for the year (s.149)</Text>
            {(
              [
                ["Taxable pay earlier this tax year", formatAmount(slip.taxableBefore.plus(slip.assumedTaxable))],
                ["Taxable pay this month", formatAmount(slip.taxable)],
                ["Taxable pay expected for the year", formatAmount(slip.annualTaxable)],
                ["Tax on it for the year", formatAmount(slip.annualTax)],
                ["Deducted earlier this tax year", formatAmount(slip.taxBefore.plus(slip.assumedTax))],
                ["Months left, this one included", String(slip.monthsLeft)],
              ] as [string, string][]
            ).map(([label, value]) => (
              <View key={label} style={styles.row}>
                <Text>{label}</Text>
                <Text>{value}</Text>
              </View>
            ))}
          </View>
        </View>
        {slip.assumedMonths > 0 ? (
          <Text style={styles.note}>
            Earlier this tax year includes {slip.assumedMonths} {slip.assumedMonths === 1 ? "month" : "months"} before payroll was run here, taken as paid the regular pay and taxed evenly on it.
          </Text>
        ) : null}
        <Text style={styles.note}>
          Income tax is deducted under section 149 of the Income Tax Ordinance, 2001: the year&apos;s tax on the pay expected for the tax year, less what was deducted earlier, spread over the months left. Commission
          is paid as it is released by the customers&apos; payments and approved.
        </Text>

        <View style={styles.footer} fixed>
          <Text>
            Payslip for {slip.name}, {monthName(run.month)} · printed {formatDateTime(printedAt)}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** The PDF's bytes. */
export async function renderPayslipPdf(props: Props): Promise<Uint8Array> {
  return new Uint8Array(await renderToBuffer(<PayslipPdf {...props} />));
}
