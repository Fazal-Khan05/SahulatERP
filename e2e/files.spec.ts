import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, directClient, hasE2EEnv, type TestUser } from "./support/admin";
import { signIn, test } from "./support/ui";

// Step 4 acceptance, the file half: a file uploads and downloads through a signed link. The job
// half (fails twice, succeeds on the third try) is in src/modules/jobs/worker.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

// A name with Urdu and an accent: download names must survive as they were typed.
const NAME = "Bill of lading رسید é.pdf";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let outsider: TestUser;
let tenantId: string;
let fileId: string;
let key: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("files-owner", { canCreateCompany: true });
  seller = await createUser("files-seller", { canCreateCompany: false });
  outsider = await createUser("files-outsider", { canCreateCompany: true });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner adds a file and downloads it through a link that the object store signed", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Files Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Files Traders");
  // A new company lands on the setup wizard; this test starts from Home, on a fresh page.
  await page.goto("/");
  const tenants = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  tenantId = tenants[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by)
    values (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;

  await page.goto("/settings/files");
  await expect(page.getByText("No files yet.")).toBeVisible();
  await page.getByLabel("File", { exact: true }).setInputFiles({ name: NAME, mimeType: "application/pdf", buffer: PDF });
  await page.getByRole("button", { name: "Add file" }).click();

  const row = page.getByRole("table", { name: "Files" }).getByRole("row").filter({ hasText: NAME });
  await expect(row).toContainText("PDF");
  await expect(row).toContainText(`${PDF.length} B`);
  await expect(row).toContainText(owner.email);

  const stored = await sql`select id, storage_key, status, size_bytes, content_type from public.files where tenant_id = ${tenantId}`;
  expect(stored).toHaveLength(1);
  fileId = stored[0].id;
  key = stored[0].storage_key;
  expect(stored[0]).toMatchObject({ status: "stored", size_bytes: PDF.length, content_type: "application/pdf", storage_key: `${tenantId}/${fileId}` });
  expect(await sql`select 1 from public.audit_log where entity_id = ${fileId} and action = 'file.upload'`).toHaveLength(1);

  // The app answers with a redirect to a signed link at the object store, good for one minute.
  const answer = await page.request.get(`/files/${fileId}`, { maxRedirects: 0 });
  expect(answer.status()).toBe(302);
  const link = answer.headers().location;
  expect(link).toContain(`/storage/v1/object/sign/files/${tenantId}/${fileId}`);
  expect(link).toContain("token=");
  // The link carries its own proof: it works with no session at all, and returns the same bytes.
  const fetched = await fetch(link);
  expect(fetched.status).toBe(200);
  expect(fetched.headers.get("content-type")).toBe("application/pdf");
  expect(Buffer.compare(Buffer.from(await fetched.arrayBuffer()), PDF)).toBe(0);
  // Without its signature the same address gives nothing.
  expect((await fetch(link.split("?")[0])).ok).toBe(false);

  // And from the screen: the name is a download.
  const download = page.waitForEvent("download");
  await row.getByRole("link", { name: NAME }).click();
  expect((await download).suggestedFilename()).toBe(NAME);
});

test("a file that is not what its name says is refused", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/settings/files");
  await page.getByLabel("File", { exact: true }).setInputFiles({ name: "statement.pdf", mimeType: "application/pdf", buffer: Buffer.from("<script>alert(1)</script>") });
  await page.getByRole("button", { name: "Add file" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("Use a PDF, PNG, JPEG or WebP file.");
  expect(await sql`select 1 from public.files where tenant_id = ${tenantId}`).toHaveLength(1);
});

test("another company's owner and a salesperson cannot see or fetch the file through the app", async ({ page, browser }) => {
  await signIn(page, outsider);
  await page.getByLabel("Company name").fill("E2E Files Rival");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Files Rival");
  // A new company lands on the setup wizard; this test starts from Home, on a fresh page.
  await page.goto("/");
  await page.goto("/settings/files");
  await expect(page.getByText("No files yet.")).toBeVisible();
  await expect(page.getByText(NAME)).toHaveCount(0);
  expect((await page.request.get(`/files/${fileId}`, { maxRedirects: 0 })).status()).toBe(404);

  const context = await browser.newContext();
  const sellerPage = await context.newPage();
  await signIn(sellerPage, seller);
  await sellerPage.goto("/settings/files");
  await expect(sellerPage.getByText("Only an owner or an auditor can see the files.")).toBeVisible();
  await expect(sellerPage.getByRole("navigation", { name: "Settings" }).getByRole("link")).toHaveText(["Branches"]);
  expect((await sellerPage.request.get(`/files/${fileId}`, { maxRedirects: 0 })).status()).toBe(404);
  await context.close();
});

test("the object store itself refuses them, even when asked directly", async () => {
  // Talking straight to Supabase Storage with each person's own session, past the app entirely.
  const asOwner = await directClient(owner);
  const signed = await asOwner.storage.from("files").createSignedUrl(key, 30);
  expect(signed.error).toBeNull();
  expect(signed.data?.signedUrl).toContain("token=");

  for (const person of [outsider, seller]) {
    const client = await directClient(person);
    const bucket = client.storage.from("files");
    expect((await bucket.createSignedUrl(key, 30)).error, `${person.email} sign`).not.toBeNull();
    expect((await bucket.download(key)).error, `${person.email} download`).not.toBeNull();
    const smuggled = await bucket.upload(`${tenantId}/smuggled-by-${person.id}`, PDF, { contentType: "application/pdf" });
    expect(smuggled.error, `${person.email} upload`).not.toBeNull();
    expect((await bucket.list(tenantId)).data ?? [], `${person.email} list`).toEqual([]);
  }
  // Nobody can overwrite or remove the owner's file, the owner included: there is no such policy.
  expect((await asOwner.storage.from("files").upload(key, PDF, { contentType: "application/pdf", upsert: true })).error).not.toBeNull();
  await asOwner.storage.from("files").remove([key]);
  expect((await asOwner.storage.from("files").createSignedUrl(key, 30)).error).toBeNull();
});
