import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import type { ObjectStore } from "@/lib/storage";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { uploadFile } from "./commands";
import { getFile, listFiles } from "./queries";
import { FILE_MAX_BYTES, checkFile, fileNameSchema, formatBytes, sniffFileType, storageKey } from "./rules";
import { files } from "./schema";

const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("file rules", () => {
  it("tells a file's type from its contents", () => {
    expect(sniffFileType(pdf)).toBe("application/pdf");
    expect(sniffFileType(png)).toBe("image/png");
    expect(sniffFileType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffFileType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(sniffFileType(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffFileType(new TextEncoder().encode("MZ executable"))).toBeNull();
  });

  it("refuses an empty file, an oversized one and an unknown type", () => {
    expect(checkFile(new Uint8Array())).toEqual({ ok: false, reason: "Choose a file." });
    const big = new Uint8Array(FILE_MAX_BYTES + 1);
    big.set(pdf);
    expect(checkFile(big)).toEqual({ ok: false, reason: "The file must be 4 MB or smaller." });
    expect(checkFile(new TextEncoder().encode("hello"))).toEqual({ ok: false, reason: "Use a PDF, PNG, JPEG or WebP file." });
    expect(checkFile(pdf)).toEqual({ ok: true, contentType: "application/pdf" });
  });

  it("keeps only the last part of a name and drops control characters", () => {
    expect(fileNameSchema.parse("  Bill of lading.pdf ")).toBe("Bill of lading.pdf");
    expect(fileNameSchema.parse("C:\\Users\\me\\scan.pdf")).toBe("scan.pdf");
    expect(fileNameSchema.parse("../../etc/passwd")).toBe("passwd");
    expect(fileNameSchema.parse("a\u0000b\nc.pdf")).toBe("abc.pdf");
    expect(fileNameSchema.safeParse("folder/").success).toBe(false);
    expect(fileNameSchema.parse("x".repeat(300))).toHaveLength(200);
  });

  it("builds the storage key from the company and the file, and prints sizes", () => {
    expect(storageKey("t", "f")).toBe("t/f");
    expect([512, 2048, 3 * 1024 * 1024].map(formatBytes)).toEqual(["512 B", "2 KB", "3.0 MB"]);
  });
});

// The upload command and the policies against a real database, with an object store kept in
// memory. Supabase Storage's own policies are exercised by the browser tests.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-files-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const ownerA = randomUUID();
const auditorA = randomUUID();
const salesA = randomUUID();
const ownerB = randomUUID();

const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({
  userId,
  email: `${role}@files.test`,
  tenantId,
  tenantName: "x",
  role,
  branchIds: null,
});
const owner = ctx(ownerA, tenantA, "owner");
const auditor = ctx(auditorA, tenantA, "auditor");
const sales = ctx(salesA, tenantA, "salesperson");
const otherOwner = ctx(ownerB, tenantB, "owner");

function memoryStore(options: { fail?: boolean } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const store: ObjectStore = {
    async put(key, bytes, contentType) {
      if (options.fail) throw new Error("store is down");
      objects.set(key, { bytes, contentType });
    },
    async signedDownloadUrl(key) {
      return `memory://${key}`;
    },
  };
  return { store, objects };
}

let admin: AdminSql;
const DENIED = "42501";
const CHECK_VIOLATION = "23514";

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

describe.skipIf(!hasDb)("stored files", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(
      admin,
      stale.map((r) => r.id),
    );
    await admin`insert into public.tenants (id, name, created_by) values
      (${tenantA}, ${PREFIX + " A"}, ${ownerA}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
      (${tenantA}, ${ownerA}, ${owner.email}, 'owner', ${ownerA}),
      (${tenantA}, ${auditorA}, ${auditor.email}, 'auditor', ${ownerA}),
      (${tenantA}, ${salesA}, ${sales.email}, 'salesperson', ${ownerA}),
      (${tenantB}, ${ownerB}, ${otherOwner.email}, 'owner', ${ownerB})`;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("stores a file: the row, the bytes under the company's key, and the audit row", async () => {
    const { store, objects } = memoryStore();
    const { id } = await uploadFile(owner, store, { name: "invoices/Bill of lading.pdf", bytes: pdf });

    const [stored] = await admin`select * from public.files where id = ${id}`;
    expect(stored).toMatchObject({
      tenant_id: tenantA,
      storage_key: `${tenantA}/${id}`,
      name: "Bill of lading.pdf",
      content_type: "application/pdf",
      size_bytes: pdf.length,
      status: "stored",
      created_by: ownerA,
    });
    expect(stored.stored_at).not.toBeNull();
    expect([...objects.keys()]).toEqual([`${tenantA}/${id}`]);
    expect(objects.get(`${tenantA}/${id}`)).toEqual({ bytes: pdf, contentType: "application/pdf" });

    const audited = await admin`select actor_user_id, action, after from public.audit_log where entity_id = ${id}`;
    expect(audited).toEqual([
      { actor_user_id: ownerA, action: "file.upload", after: { name: "Bill of lading.pdf", contentType: "application/pdf", sizeBytes: pdf.length } },
    ]);

    expect((await listFiles(owner)).map((f) => [f.id, f.name, f.addedBy])).toEqual([[id, "Bill of lading.pdf", owner.email]]);
    expect(await getFile(auditor, id)).toMatchObject({ id, storageKey: `${tenantA}/${id}` });
    // Another company does not find it, by list or by id.
    expect(await listFiles(otherOwner)).toEqual([]);
    expect(await getFile(otherOwner, id)).toBeNull();
    expect(await getFile(owner, "not-a-uuid")).toBeNull();
  });

  it("keeps files from roles that may not see or add them", async () => {
    const { store, objects } = memoryStore();
    await expect(listFiles(sales)).rejects.toBeInstanceOf(UserError);
    await expect(getFile(sales, randomUUID())).rejects.toBeInstanceOf(UserError);
    await expect(uploadFile(auditor, store, { name: "a.pdf", bytes: pdf })).rejects.toBeInstanceOf(UserError);
    await expect(uploadFile(sales, store, { name: "a.pdf", bytes: pdf })).rejects.toBeInstanceOf(UserError);
    expect(objects.size).toBe(0);
    // And the database says the same, whatever the app thinks.
    expect(await withTenant(salesA, tenantA, (tx) => tx.select().from(files))).toEqual([]);
    const id = randomUUID();
    const mine = { id, tenantId: tenantA, storageKey: `${tenantA}/${id}`, name: "a.pdf", contentType: "application/pdf", sizeBytes: 10 };
    for (const who of [salesA, auditorA]) {
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(files).values({ ...mine, createdBy: who })))).toBe(DENIED);
    }
  });

  it("refuses a file that is not what it claims, and stores nothing", async () => {
    const { store, objects } = memoryStore();
    const before = await admin`select count(*)::int as n from public.files where tenant_id = ${tenantA}`;
    await expect(uploadFile(owner, store, { name: "report.pdf", bytes: new TextEncoder().encode("<script>") })).rejects.toThrow(
      "Use a PDF, PNG, JPEG or WebP file.",
    );
    await expect(uploadFile(owner, store, { name: "/", bytes: pdf })).rejects.toThrow("The file needs a name.");
    expect(objects.size).toBe(0);
    expect(await admin`select count(*)::int as n from public.files where tenant_id = ${tenantA}`).toEqual(before);
  });

  it("leaves an upload pending, unlisted and unaudited when the object store fails", async () => {
    const { store } = memoryStore({ fail: true });
    await expect(uploadFile(owner, store, { name: "lost.png", bytes: png })).rejects.toThrow("store is down");
    const [pending] = await admin`select id, status, stored_at from public.files where tenant_id = ${tenantA} and name = 'lost.png'`;
    expect(pending).toMatchObject({ status: "pending", stored_at: null });
    expect((await listFiles(owner)).map((f) => f.name)).not.toContain("lost.png");
    expect(await getFile(owner, pending.id)).toBeNull();
    expect(await admin`select 1 from public.audit_log where entity_id = ${pending.id}`).toHaveLength(0);
  });

  it("never lets a row point into another company's files or be rewritten", async () => {
    const id = randomUUID();
    const base = { id, name: "a.pdf", contentType: "application/pdf", sizeBytes: 10, createdBy: ownerA };
    // Into company B, from either context.
    for (const context of [tenantA, tenantB]) {
      expect(
        await codeOf(() => withTenant(ownerA, context, (tx) => tx.insert(files).values({ ...base, tenantId: tenantB, storageKey: `${tenantB}/${id}` }))),
      ).toBe(DENIED);
    }
    // A row in company A whose key points at company B's folder.
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.insert(files).values({ ...base, tenantId: tenantA, storageKey: `${tenantB}/${id}` }))),
    ).toBe(CHECK_VIOLATION);
    // Born already stored, or as somebody else.
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) => tx.insert(files).values({ ...base, tenantId: tenantA, storageKey: `${tenantA}/${id}`, status: "stored", storedAt: new Date() })),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.insert(files).values({ ...base, tenantId: tenantA, storageKey: `${tenantA}/${id}`, createdBy: ownerB }))),
    ).toBe(DENIED);
    // Only the status may change; the name, the key and the company may not, and nothing is deletable.
    for (const change of [{ name: "renamed.pdf" }, { storageKey: `${tenantB}/${id}` }, { tenantId: tenantB }, { sizeBytes: 1 }]) {
      expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.update(files).set(change)))).toBe(DENIED);
    }
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(files)))).toBe(DENIED);
  });
});
