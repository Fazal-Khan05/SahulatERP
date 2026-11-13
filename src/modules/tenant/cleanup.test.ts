import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSql, deleteOrder, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";

// The tests remove the companies they make. The list of tables to empty is not written down
// anywhere: it is read from the database, so a step that adds a table has nothing to add to a
// shared file. These tests hold the two things that reading relies on.

describe("the order in which a test company is removed", () => {
  it("empties a table before every table it points at", () => {
    const order = deleteOrder([
      { name: "tenants", parents: [] },
      { name: "customers", parents: ["tenants"] },
      { name: "invoices", parents: ["tenants", "customers"] },
      { name: "invoice_lines", parents: ["invoices", "items", "tenants"] },
      { name: "items", parents: ["tenants"] },
    ]);
    expect(order).toEqual(["invoice_lines", "invoices", "items", "customers", "tenants"]);
  });

  it("still gives an order when two tables point at each other, with everything else in its place", () => {
    const order = deleteOrder([
      { name: "tenants", parents: [] },
      { name: "a", parents: ["b", "tenants"] },
      { name: "b", parents: ["a", "tenants"] },
      { name: "a_lines", parents: ["a", "tenants"] },
    ]);
    // The pair cannot be ordered by its keys (one of them must be deferrable); the table that
    // points at the pair still goes first, and the company itself last.
    expect(order).toEqual(["a_lines", "a", "b", "tenants"]);
  });
});

describe.skipIf(!hasAdminDb())("the database the clean-up reads", () => {
  let admin: AdminSql;
  beforeAll(() => {
    admin = adminSql();
  });
  afterAll(async () => {
    await admin.end();
  });

  it("has tenant_id on every table, so nothing of a company is left behind", async () => {
    const without = await admin`
      select c.relname as name from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)`;
    expect(without.map((t) => t.name)).toEqual([]);
  });

  it("removes a company with rows in it, and leaves the others alone", async () => {
    const [mine, other, user] = [randomUUID(), randomUUID(), randomUUID()];
    try {
      for (const id of [mine, other]) {
        await admin`insert into public.tenants (id, name, created_by) values (${id}, ${"zz-cleanup-test " + id.slice(0, 8)}, ${user})`;
        await admin`insert into public.branches (tenant_id, name, created_by) values (${id}, 'Main', ${user})`;
      }
      await deleteTenants(admin, [mine]);
      const left = await admin`select tenant_id from public.branches where tenant_id = any(${[mine, other]})`;
      expect(left.map((b) => b.tenant_id)).toEqual([other]);
      expect((await admin`select id from public.tenants where id = any(${[mine, other]})`).map((t) => t.id)).toEqual([other]);
    } finally {
      await deleteTenants(admin, [mine, other]);
    }
  });
});
