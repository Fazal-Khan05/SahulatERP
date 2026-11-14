import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { renderSalesPdf } from "./pdf";
import { printedTable } from "./rules";
import type { PrintView } from "./view";

// The smallest PNG there is: one transparent pixel.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

function view(lines: number): PrintView {
  const line = { itemCode: "BRK-01", description: "Brake shoe, rear, for 70cc", unitCode: "pcs", quantity: new Decimal(10), unitPrice: new Decimal(100), discountPercent: null, taxKind: "standard", taxRate: new Decimal(18), taxAmount: new Decimal(180), furtherTaxAmount: new Decimal(0), extraTaxAmount: new Decimal(0), value: new Decimal(1000), total: new Decimal(1180) };
  return {
    title: "Sales tax invoice",
    number: "SI-2627-00001",
    cancelled: null,
    seller: ["NTN 1234567-8", "STRN 1234567890123"],
    buyerHeading: "Bill to",
    buyer: ["Lahore Bike Parts", "Shop 4, Main Market", "Punjab"],
    facts: [["Date", "14-11-2026"], ["Due", "14-12-2026"]],
    table: printedTable({ lines: Array.from({ length: lines }, () => line), prices: true, taxed: true, pricesIncludeTax: false, currency: "PKR", totals: { value: new Decimal(1000 * lines), tax: new Decimal(180 * lines), furtherTax: new Decimal(0), extraTax: new Decimal(0), total: new Decimal(1180 * lines) }, formatAmount: (amount) => amount.toFixed(2) }),
    words: "Rupees One Thousand One Hundred Eighty Only",
    notes: "Thank you for your business.",
    signatures: [],
  };
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("the PDF of a sales document", () => {
  it("is a PDF, titled with the document's number", async () => {
    const bytes = await renderSalesPdf({ view: view(3), companyName: "Test Traders", productName: "SahulatERP", logo: { bytes: PNG, contentType: "image/png" }, printedAt: new Date("2026-11-14T10:00:00Z") });
    expect(text(bytes.slice(0, 5))).toBe("%PDF-");
    expect(text(bytes)).toContain("(Sales tax invoice SI-2627-00001)");
    // The logo is drawn as a picture.
    expect(text(bytes)).toContain("/Subtype /Image");
  });

  it("leaves off a logo it cannot draw, and still makes the PDF", async () => {
    const bytes = await renderSalesPdf({ view: view(1), companyName: "Test Traders", productName: "SahulatERP", logo: { bytes: PNG, contentType: "image/webp" }, printedAt: new Date() });
    expect(text(bytes.slice(0, 5))).toBe("%PDF-");
    expect(text(bytes)).not.toContain("/Subtype /Image");
  });

  it("runs onto more pages when the lines do", async () => {
    const one = await renderSalesPdf({ view: view(2), companyName: "Test Traders", productName: "SahulatERP", logo: null, printedAt: new Date() });
    const many = await renderSalesPdf({ view: { ...view(120), signatures: ["Delivered by", "Received by"] }, companyName: "Test Traders", productName: "SahulatERP", logo: null, printedAt: new Date() });
    const pages = (bytes: Uint8Array) => (text(bytes).match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages(one)).toBe(1);
    expect(pages(many)).toBeGreaterThan(1);
  });
});
