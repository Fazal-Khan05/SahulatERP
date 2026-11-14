import { crc32, deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 23 on screen: a posted invoice is printed on the company's letterhead with its logo, its
// PDF is downloaded, and its page says what happened to it. Email is not set up until a service
// is chosen, and the page says so. Sending itself, with a stand-in for the service, is tested in
// src/modules/sales-email/email.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

/** A PNG of one colour, made here so the test needs no file. */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [200, 30, 30]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}
const LOGO = solidPng(2, 2);

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let invoiceId: string;
let orderId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("print-owner", { canCreateCompany: true });
  keeper = await createUser("print-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const timeline = (page: Page) => page.getByRole("list", { name: "What happened" }).filter({ visible: true }).locator("li");

test("an owner posts an invoice, prints it on the letterhead with the logo, and downloads its PDF", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Print Traders");
  const [{ id: tenantId }] = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  // A company has no settings row until its branding is first saved.
  await sql`insert into public.settings (tenant_id, product_name, logo, logo_content_type, created_by, updated_by) values (${tenantId}, 'SahulatERP', ${LOGO}, 'image/png', ${owner.id}, ${owner.id})
    on conflict (tenant_id) do update set logo = excluded.logo, logo_content_type = excluded.logo_content_type, updated_at = now()`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'BP-100', 'Brake pad', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  const [customer] = await sql`insert into public.customers (tenant_id, name, code, created_by, updated_by) values (${tenantId}, 'Khan Autos', 'C-001', ${owner.id}, ${owner.id}) returning id`;
  await sql`insert into public.contacts (tenant_id, customer_id, name, email, created_by, updated_by) values (${tenantId}, ${customer.id}, 'Imran', 'imran@khan-autos.test', ${owner.id}, ${owner.id})`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "10", value: "6000", userId: owner.id });

  await page.goto("/sales/new?kind=order");
  const picked = page.getByRole("combobox", { name: "Customer", exact: true });
  await picked.fill("C-001");
  await picked.press("Tab");
  await expect(picked).toHaveAttribute("data-picked", "true");
  const line = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await line.fill("BP-100");
  await line.press("Tab");
  await expect(line).toHaveAttribute("data-picked", "true");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00001" })).toBeVisible();
  orderId = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Invoice and deliver now" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  invoiceId = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toBeVisible();

  // The invoice's page: print, PDF, and email, which waits for a service to be chosen.
  await expect(visible(page, "print-link")).toBeVisible();
  await expect(visible(page, "pdf-link")).toBeVisible();
  await expect(visible(page, "email-not-set-up")).toContainText("Email is not set up yet");
  await expect(page.getByRole("button", { name: "Send email" })).toHaveCount(0);
  // What happened to it, in order.
  await expect(timeline(page)).toHaveCount(2);
  await expect(timeline(page).nth(0)).toContainText("Written from sales order SO-2627-00001");
  await expect(timeline(page).nth(0)).toContainText(`you (${owner.email})`);
  await expect(timeline(page).nth(1)).toContainText("Posted");

  // The printed page: the letterhead with the company's logo, the buyer, the lines and the total in words.
  await visible(page, "print-link").click();
  await expect(page.getByTestId("print-number")).toHaveText("SI-2627-00001");
  await expect(page.getByTestId("print-title")).toHaveText("Invoice");
  const header = page.getByTestId("print-header");
  await expect(header).toContainText("E2E Print Traders");
  const logo = header.locator("img");
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2);
  await expect(page.getByTestId("print-buyer")).toHaveText("Khan Autos");
  const rows = page.getByRole("table", { name: "Lines" }).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("BP-100");
  await expect(rows.nth(0)).toContainText("2 pc");
  await expect(page.getByTestId("print-total")).toHaveText("2,000.00");
  await expect(page.getByTestId("print-words")).toHaveText("Rupees Two Thousand Only");

  // The PDF: a real file named after the invoice, with the logo drawn in it.
  const download = page.waitForEvent("download");
  await page.getByTestId("download-pdf").click();
  expect((await download).suggestedFilename()).toBe("SI-2627-00001.pdf");
  const response = await page.request.get(`/print/sales/${invoiceId}/pdf`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const pdf = Buffer.from(await response.body()).toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf).toContain("(Invoice SI-2627-00001)");
  expect(pdf).toContain("/Subtype /Image");

  // The order says the invoice was made from it.
  await page.goto(`/sales/${orderId}`);
  await expect(timeline(page).filter({ hasText: "Sales invoice made from this" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Sales invoice SI-2627-00001" })).toBeVisible();
});

test("the warehouse prints its delivery documents without prices and gets no invoice", async ({ page }) => {
  await signIn(page, keeper);
  // An order is printed for the warehouse with what and how much, not what it sells for.
  await page.goto(`/print/sales/${orderId}`);
  await expect(page.getByTestId("print-title")).toHaveText("Sales order");
  await expect(page.getByRole("table", { name: "Lines" }).locator("thead th")).toHaveText(["Item", "Description", "Quantity"]);
  await expect(page.getByTestId("print-total")).toHaveCount(0);
  // The invoice is not theirs to see, printed or as a PDF.
  await page.goto(`/print/sales/${invoiceId}`);
  await expect(page.getByTestId("print-number")).toHaveCount(0);
  expect((await page.request.get(`/print/sales/${invoiceId}/pdf`)).status()).toBe(404);
});
