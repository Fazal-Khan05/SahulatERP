import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { addUnit, createItem } from "@/modules/items/commands";
import { seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { renderSalesPdf } from "@/modules/sales-print/pdf";
import { getPrintableDocument } from "@/modules/sales-print/queries";
import { pdfFileName } from "@/modules/sales-print/rules";
import { printView } from "@/modules/sales-print/view";
import { getTimeline } from "@/modules/sales-timeline/queries";
import { cancelSalesDocument, postDelivery, saveDeliveryDraft, saveSalesDraft, startDelivery, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { seedStock } from "../../../tests/support/stock";
import { emailSalesDocument, settleEmail } from "./commands";
import { getCustomerEmail, listDocumentEmails } from "./queries";
import type { MailSender, OutgoingEmail, SendResult } from "./rules";

// Step 23 against a real database, through the app's own path: printing a sales document, making
// its PDF, emailing it through a stand-in for the email service, and its timeline. The email
// service is not chosen yet, so every send here goes to the stand-in. Skipped without the
// database URLs.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-email-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const seller2 = randomUUID();
const ownerB = randomUUID();
const branch = randomUUID();
const warehouse = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@email.test`, tenantId, tenantName: "Test Traders", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const second = ctx(seller2, tenantA, "salesperson");
const other = ctx(ownerB, tenantB, "owner");
const D = "2026-11-14";
const BUYER = "buyer@khan-autos.test";
const form = (extra: Partial<{ to: unknown; subject: unknown; message: unknown }> = {}) => ({ to: BUYER, subject: "Quotation", message: "Please find it attached.", ...extra });

let admin: AdminSql;
let pad: string;
let khan: string;

/** A stand-in for the email service: says what it is told to, and keeps what it was given. */
function fakeSender(answers: { send?: SendResult | Error; lookup?: SendResult | null } = {}) {
  const sent: { email: OutgoingEmail; key: string; rowStatus: string | undefined }[] = [];
  const asked: string[] = [];
  const sender: MailSender = {
    provider: "stand-in",
    async send(email, key) {
      // The intent is in the database before the service is called.
      const [row] = await admin<{ status: string }[]>`select status from public.sales_document_emails where id = ${key}`;
      sent.push({ email, key, rowStatus: row?.status });
      const answer = answers.send ?? { outcome: "sent", messageId: `msg-${sent.length}` };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async lookup(key) {
      asked.push(key);
      return answers.lookup ?? null;
    },
  };
  return { sender, sent, asked };
}

async function pdfOf(who: TenantContext, id: string) {
  const printable = await getPrintableDocument(who, id, who.tenantName);
  if (!printable) throw new Error("not printable");
  return { filename: pdfFileName(printable.document.number), bytes: await renderSalesPdf({ view: printView(printable), companyName: who.tenantName, productName: "SahulatERP", logo: null, printedAt: new Date() }) };
}
const send = (who: TenantContext, sender: MailSender | null, documentId: string, extra: Parameters<typeof form>[0] = {}) => emailSalesDocument(who, sender, { documentId, form: form(extra) }, () => pdfOf(who, documentId));

async function quotation(who: TenantContext): Promise<string> {
  const { id } = await saveSalesDraft(who, null, { kind: "quotation", date: D, customerId: khan, warehouseId: warehouse, lines: [{ itemId: pad, quantity: "4", unitId: "", unitPrice: "", discountPercent: "", description: "" }], shares: [] });
  await submitSalesDocument(who, id);
  return id;
}
const emailRows = (documentId: string) => admin<{ status: string; provider: string | null; provider_message_id: string | null; error: string | null; to_address: string }[]>`select status, provider, provider_message_id, error, to_address from public.sales_document_emails where document_id = ${documentId} order by created_at`;
const audits = (documentId: string) => admin<{ action: string }[]>`select action from public.audit_log where entity_id = ${documentId} and action like 'sales_document.email%' order by at, action`;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

describe.skipIf(!hasDb)("printing and emailing sales documents", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${branch}, ${tenantA}, 'Main', ${userIds.owner})`;
    await admin`insert into public.warehouses (id, tenant_id, branch_id, name, created_by) values (${warehouse}, ${tenantA}, ${branch}, 'Main store', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: seller2, email: second.email, role: "salesperson", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: other.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    await admin`insert into public.company_setup (tenant_id, sales_tax_registered, ntn, accounts_template, completed_by) values (${tenantA}, false, '7654321', 'trading', ${userIds.owner})`;
    await setBaseCurrency(as.owner, { code: "PKR", name: "Pakistani Rupee" });
    await seedAccounts(as.owner, "trading");
    await openFiscalYear(as.owner, { month: "7", year: "2026" });
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    pad = (await createItem(as.owner, { code: "BP-100", name: "Brake pad", unit: piece, defaultPrice: "312.50" })).id;
    khan = (await createParty(as.owner, "customer", { name: "Khan Autos", code: "C-001", contactName: "Imran", email: BUYER, address: "Shop 4, Main Market", province: "punjab" })).id;
    await seedStock(admin, { tenantId: tenantA, itemId: pad, warehouseId: warehouse, quantity: "10", value: "2000", userId: userIds.owner });
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("prints a numbered document with its buyer and total in words, and nothing of a draft", async () => {
    const { id: draft } = await saveSalesDraft(as.salesperson, null, { kind: "quotation", date: D, customerId: khan, warehouseId: warehouse, lines: [{ itemId: pad, quantity: "4", unitId: "", unitPrice: "", discountPercent: "", description: "" }], shares: [] });
    expect(await getPrintableDocument(as.salesperson, draft, "Test Traders")).toBeNull();

    await submitSalesDocument(as.salesperson, draft);
    const printable = (await getPrintableDocument(as.salesperson, draft, "Test Traders"))!;
    expect(printable).toMatchObject({ title: "Quotation", prices: true, seller: { name: "Test Traders", ntn: "7654321", strn: null }, words: "Rupees One Thousand Two Hundred Fifty Only" });
    const view = printView(printable);
    expect(view.buyer).toEqual(["Khan Autos", "Shop 4, Main Market", "Punjab"]);
    expect(view.table.rows).toEqual([["BP-100", "Brake pad", "4 pc", "312.50", "1,250.00"]]);
    expect(view.table.totals).toEqual([{ label: "Total (PKR)", amount: "1,250.00", strong: true }]);

    // Another salesperson, and another company, do not see it at all.
    expect(await getPrintableDocument(second, draft, "Test Traders")).toBeNull();
    expect(await getPrintableDocument(other, draft, "x")).toBeNull();
  });

  it("prints a delivery note without prices, and an order without prices for the warehouse", async () => {
    const { id: order } = await saveSalesDraft(as.owner, null, { kind: "order", date: D, customerId: khan, warehouseId: warehouse, lines: [{ itemId: pad, quantity: "2", unitId: "", unitPrice: "", discountPercent: "", description: "" }], shares: [] });
    await submitSalesDocument(as.owner, order);
    expect((await getPrintableDocument(as.warehouse_manager, order, "x"))!.prices).toBe(false);
    expect((await getPrintableDocument(as.auditor, order, "x"))!.prices).toBe(true);

    const { id: note } = await startDelivery(as.warehouse_manager, order);
    const draft = (await getSalesDocument(as.warehouse_manager, note))!;
    await saveDeliveryDraft(as.warehouse_manager, note, { date: D, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
    await postDelivery(as.warehouse_manager, note);
    const printable = (await getPrintableDocument(as.owner, note, "x"))!;
    expect(printable).toMatchObject({ title: "Delivery note", prices: false, words: null });
    const view = printView(printable);
    expect(view.table.columns.map((c) => c.label)).toEqual(["Item", "Description", "Quantity"]);
    expect(view.signatures).toHaveLength(2);
    expect(view.facts).toContainEqual(["Sales order", "SO-2627-00001"]);
  });

  it("offers the customer's contact email to those who may read customers", async () => {
    expect(await getCustomerEmail(as.salesperson, khan)).toBe(BUYER);
    expect(await getCustomerEmail(as.warehouse_manager, khan)).toBeNull();
  });

  it("refuses everything while no email service is set up, and writes nothing", async () => {
    const id = await quotation(as.salesperson);
    await expect(send(as.salesperson, null, id)).rejects.toThrow("Email is not set up yet.");
    expect(await emailRows(id)).toEqual([]);
  });

  it("writes the intent, sends the PDF, then writes the outcome, each with its audit row", async () => {
    const id = await quotation(as.salesperson);
    const number = (await getSalesDocument(as.salesperson, id))!.number!;
    const { sender, sent } = fakeSender();
    expect(await send(as.salesperson, sender, id)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].rowStatus).toBe("sending");
    expect(sent[0].email).toMatchObject({ to: BUYER, subject: "Quotation", text: "Please find it attached.", replyTo: as.salesperson.email });
    expect(sent[0].email.attachment.filename).toBe(`${number}.pdf`);
    expect(Buffer.from(sent[0].email.attachment.content.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(await emailRows(id)).toEqual([{ status: "sent", provider: "stand-in", provider_message_id: "msg-1", error: null, to_address: BUYER }]);
    expect((await audits(id)).map((a) => a.action)).toEqual(["sales_document.email", "sales_document.email_outcome"]);

    // The timeline tells it, naming the salesperson to themselves.
    const document = (await getSalesDocument(as.salesperson, id))!;
    const events = await getTimeline(as.salesperson, document);
    expect(events.map((e) => e.what)).toEqual(["Written", "Submitted", `Emailed to ${BUYER}`]);
    expect(events[2].who).toBe(`you (${as.salesperson.email})`);
    // The owner sees who sent it.
    expect((await getTimeline(as.owner, document))[2].who).toBe(as.salesperson.email);
  });

  it("records a refusal, in its own short words", async () => {
    const id = await quotation(as.owner);
    const { sender } = fakeSender({ send: { outcome: "failed", reason: `The address does not exist.\n${"x".repeat(400)}` } });
    expect(await send(as.owner, sender, id)).toBe("failed");
    const [row] = await emailRows(id);
    expect(row.status).toBe("failed");
    expect(row.error!.startsWith("The address does not exist. x")).toBe(true);
    expect(row.error!.length).toBe(300);
    // A failed email does not stop the next one.
    expect(await send(as.owner, fakeSender().sender, id)).toBe("sent");
  });

  it("never sends twice blindly: an unknown outcome is asked about, and settled by the service or a member", async () => {
    const id = await quotation(as.owner);
    // The connection drops part-way: nobody knows whether it went.
    expect(await send(as.owner, fakeSender({ send: new Error("socket hang up") }).sender, id)).toBe("unknown");
    expect((await emailRows(id))[0]).toMatchObject({ status: "unknown", provider: "stand-in" });

    // The service still cannot say: the document is not sent again.
    const silent = fakeSender();
    await expect(send(as.owner, silent.sender, id)).rejects.toThrow("may or may not have arrived");
    expect(silent.asked).toHaveLength(1);
    expect(silent.sent).toHaveLength(0);

    // The service says it went: that email is settled, and the new one is sent.
    const knows = fakeSender({ lookup: { outcome: "sent", messageId: "late-1" } });
    expect(await send(as.owner, knows.sender, id)).toBe("sent");
    expect((await emailRows(id)).map((r) => `${r.status} ${r.provider_message_id}`)).toEqual(["sent late-1", "sent msg-1"]);

    // Another unknown one, settled by a member who asked the customer.
    expect(await send(as.owner, fakeSender({ send: { outcome: "unknown", reason: "timed out" } }).sender, id)).toBe("unknown");
    const [, , unknown] = await listDocumentEmails(as.owner, id);
    await expect(settleEmail(as.auditor, unknown.id, false)).rejects.toThrow("Your role cannot email sales documents.");
    await settleEmail(as.owner, unknown.id, false);
    await expect(settleEmail(as.owner, unknown.id, true)).rejects.toThrow("no longer waiting");
    expect((await emailRows(id))[2]).toMatchObject({ status: "failed", error: "A member said it did not arrive." });
    expect((await audits(id)).map((a) => a.action)).toContain("sales_document.email_settle");
  });

  it("does not send while another send of the document may be under way", async () => {
    const id = await quotation(as.owner);
    await admin`insert into public.sales_document_emails (tenant_id, document_id, to_address, subject, created_by) values (${tenantA}, ${id}, ${BUYER}, 'x', ${userIds.owner})`;
    await expect(send(as.owner, fakeSender().sender, id)).rejects.toThrow("being emailed right now");
    // Left "sending" for longer than a send takes: it was interrupted, and nobody can say whether it went.
    await admin`update public.sales_document_emails set created_at = now() - interval '10 minutes' where document_id = ${id}`;
    await expect(send(as.owner, fakeSender().sender, id)).rejects.toThrow("may or may not have arrived");
    expect((await emailRows(id))[0]).toMatchObject({ status: "unknown", provider: "stand-in" });
  });

  it("refuses the roles that may not email, a cancelled document, and one this member cannot see", async () => {
    const id = await quotation(as.salesperson);
    for (const who of [as.auditor, as.warehouse_manager]) await expect(send(who, fakeSender().sender, id), who.role).rejects.toThrow("Your role cannot email sales documents.");
    await expect(send(second, fakeSender().sender, id)).rejects.toThrow("That document was not found.");
    await expect(send(other, fakeSender().sender, id)).rejects.toThrow("That document was not found.");
    await expect(send(as.salesperson, fakeSender().sender, id, { to: "not an address" })).rejects.toThrow("That is not an email address.");
    await cancelSalesDocument(as.salesperson, id, { reason: "not wanted" });
    await expect(send(as.salesperson, fakeSender().sender, id)).rejects.toThrow("Only a document that has its number");
    expect(await emailRows(id)).toEqual([]);
  });

  it("holds the log to its rules even for SQL written by hand as the app's role", async () => {
    const id = await quotation(as.salesperson);
    await send(as.salesperson, fakeSender().sender, id);
    const [{ id: emailId }] = await admin<{ id: string }[]>`select id from public.sales_document_emails where document_id = ${id}`;
    const { id: draft } = await saveSalesDraft(as.salesperson, null, { kind: "quotation", date: D, customerId: khan, warehouseId: warehouse, lines: [], shares: [] });
    const run = (who: TenantContext, statement: ReturnType<typeof sql>) => codeOf(() => withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement)));
    const insert = (documentId: string, status = "sending", by = as.salesperson.userId) =>
      sql`insert into public.sales_document_emails (tenant_id, document_id, to_address, subject, status, finished_at, provider, created_by) values (${tenantA}, ${documentId}, ${BUYER}, 'x', ${status}, ${status === "sending" ? null : sql`now()`}, ${status === "sending" ? null : "x"}, ${by})`;

    // Born "sent", for a draft, in someone else's name, or by a role that may not email: refused.
    expect(await run(as.salesperson, insert(id, "sent"))).toBe("42501");
    expect(await run(as.salesperson, insert(draft))).toBe("42501");
    expect(await run(as.salesperson, insert(id, "sending", userIds.owner))).toBe("42501");
    expect(await run(as.auditor, insert(id, "sending", userIds.auditor))).toBe("42501");
    // Another salesperson cannot write to, or see, the emails of a document that is not theirs.
    expect(await run(second, insert(id, "sending", seller2))).toBe("42501");
    const seen = (who: TenantContext) => withTenant(who.userId, who.tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from public.sales_document_emails where document_id = ${id}`));
    expect((await seen(second))[0].n).toBe(0);
    expect((await seen(other))[0].n).toBe(0);
    expect((await seen(as.auditor))[0].n).toBe(1);

    // A settled email never changes; the address and the document never change; nothing is deleted.
    const changed = (who: TenantContext, statement: ReturnType<typeof sql>) => withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    expect((await changed(as.owner, sql`update public.sales_document_emails set status = 'failed', error = 'x', provider = 'x' where id = ${emailId} returning id`)).length).toBe(0);
    expect(await run(as.owner, sql`update public.sales_document_emails set to_address = 'thief@example.test' where id = ${emailId}`)).toBe("42501");
    expect(await run(as.owner, sql`update public.sales_document_emails set document_id = ${draft} where id = ${emailId}`)).toBe("42501");
    expect(await run(as.owner, sql`delete from public.sales_document_emails where id = ${emailId}`)).toBe("42501");
    expect((await emailRows(id))[0]).toMatchObject({ status: "sent", to_address: BUYER });

    // The times are the database's: an email dated in the future would look "being sent" for ever and block the document.
    expect(await run(as.salesperson, sql`insert into public.sales_document_emails (tenant_id, document_id, to_address, subject, created_by, created_at) values (${tenantA}, ${id}, ${BUYER}, 'x', ${userIds.salesperson}, '9999-12-31')`)).toBe("42501");
    // A subject is one line, and an address is one address.
    expect(await run(as.salesperson, sql`insert into public.sales_document_emails (tenant_id, document_id, to_address, subject, created_by) values (${tenantA}, ${id}, ${BUYER}, ${"Quotation\r\nBcc: x@example.test"}, ${userIds.salesperson})`)).toBe("23514");
    for (const to of ["a@b,c@d", "a@b;c@d", "a@b x"]) {
      expect(await run(as.salesperson, sql`insert into public.sales_document_emails (tenant_id, document_id, to_address, subject, created_by) values (${tenantA}, ${id}, ${to}, 'x', ${userIds.salesperson})`), to).toBe("23514");
    }
    await expect(send(as.salesperson, fakeSender().sender, id, { subject: "Quotation\nBcc: x@example.test" })).rejects.toThrow("Keep the subject on one line.");

    // An outcome is written now, by the member writing it.
    expect(await send(as.salesperson, fakeSender({ send: { outcome: "unknown", reason: "timed out" } }).sender, id)).toBe("unknown");
    const [{ id: open }] = await admin<{ id: string }[]>`select id from public.sales_document_emails where document_id = ${id} and status = 'unknown'`;
    expect(await run(as.owner, sql`update public.sales_document_emails set status = 'sent', finished_at = '1970-01-01', finished_by = ${userIds.owner} where id = ${open}`)).toBe("42501");
    expect(await run(as.owner, sql`update public.sales_document_emails set status = 'sent', finished_at = now(), finished_by = ${userIds.salesperson} where id = ${open}`)).toBe("42501");
    const [row] = await admin<{ finished_by: string }[]>`select finished_by from public.sales_document_emails where id = ${open}`;
    expect(row.finished_by).toBe(userIds.salesperson);
    await settleEmail(as.owner, open, true);
    expect((await admin<{ finished_by: string; status: string }[]>`select finished_by, status from public.sales_document_emails where id = ${open}`)[0]).toEqual({ finished_by: userIds.owner, status: "sent" });
  });
});
