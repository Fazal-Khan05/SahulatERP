import { expect, type Page } from "@playwright/test";
import { sendPendingInvitations } from "../scripts/lib/invitations.mjs";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, emailFor, emailLink, hasE2EEnv, randomPassword, type TestUser } from "./support/admin";
import { isServerAction, signIn, test } from "./support/ui";

// Step 2 acceptance: two companies with one owner each cannot see each other's rows through the
// screens or through any server action, and signing in writes an audit row. The tests run in
// order and build on each other.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

const ALPHA = "E2E Alpha Motors";
const ALPHA_TWO = "E2E Alpha Two";
const BETA = "E2E Beta Traders";

let sql: AdminSql;
let ownerA: TestUser;
let ownerB: TestUser;
let tenantA: string;
let tenantB: string;
let betaBranchId: string;

test.beforeAll(async () => {
  sql = adminSql();
  ownerA = await createUser("owner-a", { canCreateCompany: true });
  ownerB = await createUser("owner-b", { canCreateCompany: true });
});

test.afterAll(async () => {
  await sql.end();
});

async function addBranch(page: Page, name: string) {
  await page.goto("/settings/branches");
  await page.getByLabel("Branch name").fill(name);
  await page.getByRole("button", { name: "Add branch" }).click();
  await expect(page.getByRole("list", { name: "Branches" }).getByText(name, { exact: true })).toBeVisible();
}

async function tenantIdOf(name: string, owner: TestUser): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from public.tenants where name = ${name} and created_by = ${owner.id}`;
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

async function auditCount(tenantId: string, action: string, actorId: string | null): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from public.audit_log
    where tenant_id = ${tenantId} and action = ${action} and actor_user_id is not distinct from ${actorId}`;
  return rows[0].n;
}

test("a wrong password is refused", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ownerA.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("The email or password is not right.");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("owner A signs in for the first time, creates a company and adds branches", async ({ page }) => {
  await signIn(page, ownerA);
  await expect(page).toHaveURL(/\/create-company$/);
  await page.getByLabel("Company name").fill(ALPHA);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText(ALPHA);
  await expect(page.getByText(`Signed in as ${ownerA.email}, Owner at ${ALPHA}.`)).toBeVisible();

  await addBranch(page, "Alpha Karachi");
  await addBranch(page, "Alpha Lahore");

  // The same name again is refused and nothing is added.
  await page.getByLabel("Branch name").fill("alpha karachi");
  await page.getByRole("button", { name: "Add branch" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("A branch with this name already exists.");

  tenantA = await tenantIdOf(ALPHA, ownerA);
  expect(await auditCount(tenantA, "tenant.create", ownerA.id)).toBe(1);
  expect(await auditCount(tenantA, "branch.create", ownerA.id)).toBe(2);
});

test("owner B signs in for the first time, creates a company and adds a branch", async ({ page }) => {
  await signIn(page, ownerB);
  await expect(page).toHaveURL(/\/create-company$/);
  await page.getByLabel("Company name").fill(BETA);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText(BETA);
  await addBranch(page, "Beta Lahore");

  tenantB = await tenantIdOf(BETA, ownerB);
  const branches = await sql<{ id: string }[]>`select id from public.branches where tenant_id = ${tenantB}`;
  expect(branches).toHaveLength(1);
  betaBranchId = branches[0].id;
});

test("neither owner sees the other company's rows on any screen", async ({ browser }) => {
  for (const [me, mine, other, theirs] of [
    [ownerA, { company: ALPHA, branch: "Alpha Karachi" }, ownerB, { company: BETA, branch: "Beta Lahore" }],
    [ownerB, { company: BETA, branch: "Beta Lahore" }, ownerA, { company: ALPHA, branch: "Alpha Karachi" }],
  ] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, me);

    await page.goto("/settings/branches");
    await expect(page.getByRole("list", { name: "Branches" }).getByText(mine.branch, { exact: true })).toBeVisible();
    await expect(page.getByText(theirs.branch)).toHaveCount(0);

    await page.goto("/settings/members");
    await expect(page.getByRole("table", { name: "Members" }).getByText(me.email)).toBeVisible();
    await expect(page.getByText(other.email)).toHaveCount(0);

    await page.goto("/settings/activity");
    await expect(page.getByRole("table", { name: "Activity" }).getByText("Created the company")).toBeVisible();
    await expect(page.getByText(other.email)).toHaveCount(0);
    await expect(page.getByText(theirs.branch)).toHaveCount(0);
    await expect(page.getByText(theirs.company)).toHaveCount(0);

    await context.close();
  }
});

test("a second person signing in on the same tab sees nothing of the first", async ({ page }) => {
  await signIn(page, ownerA);
  // Move around inside the app first, so the browser has the first owner's screens in memory.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Branches" }).click();
  await expect(page.getByRole("list", { name: "Branches" }).getByText("Alpha Karachi", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("table", { name: "Members" }).getByText(ownerA.email)).toBeVisible();
  await page.getByRole("link", { name: "Branches" }).click();
  await expect(page.getByRole("list", { name: "Branches" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel("Email").fill(ownerB.email);
  await page.getByLabel("Password").fill(ownerB.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("company-name")).toHaveText(BETA);

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Branches" }).click();
  await expect(page.getByRole("list", { name: "Branches" }).getByRole("listitem")).toHaveText(["Beta Lahore"]);
  await expect(page.getByText("Alpha Karachi")).toHaveCount(0);
  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("table", { name: "Members" }).getByText(ownerB.email)).toBeVisible();
  await expect(page.getByText(ownerA.email)).toHaveCount(0);
  // Going back lands on the branches page again; it must still be the second person's.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/branches$/);
  await expect(page.getByRole("list", { name: "Branches" }).getByRole("listitem")).toHaveText(["Beta Lahore"]);
  await expect(page.getByText("Alpha Karachi")).toHaveCount(0);
});

test("a forged company cookie is ignored", async ({ page, context, baseURL }) => {
  await signIn(page, ownerA);
  await context.addCookies([{ name: "active_tenant", value: tenantB, url: baseURL! }]);

  await page.goto("/");
  await expect(page.getByTestId("company-name")).toHaveText(ALPHA);
  await page.goto("/settings/branches");
  await expect(page.getByRole("list", { name: "Branches" }).getByText("Alpha Karachi", { exact: true })).toBeVisible();
  await expect(page.getByText("Beta Lahore")).toHaveCount(0);
  await page.goto("/settings/members");
  await expect(page.getByText(ownerB.email)).toHaveCount(0);
});

test("the switcher moves between the user's own companies and ignores a forged company id", async ({ page, context }) => {
  await signIn(page, ownerA);
  await page.getByRole("link", { name: "New company" }).click();
  await page.getByLabel("Company name").fill(ALPHA_TWO);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText(ALPHA_TWO);

  // A real switch.
  const switcher = page.getByLabel("Company");
  await expect(switcher.locator("option")).toHaveText([ALPHA, ALPHA_TWO]);
  await switcher.selectOption({ label: ALPHA });
  await page.getByRole("button", { name: "Switch" }).click();
  await expect(page.getByTestId("company-name")).toHaveText(ALPHA);

  // The same server action, handed the other owner's company id. Wait until the form is live,
  // so the change is made to the page React is running, not to markup it is about to take over.
  await expect(page.getByRole("button", { name: "Switch" })).toBeEnabled();
  await switcher.evaluate((select: HTMLSelectElement, forged) => {
    const option = document.createElement("option");
    option.value = forged;
    option.textContent = "forged";
    select.append(option);
    select.value = forged;
  }, tenantB);
  const forgedSwitch = page.waitForRequest(isServerAction);
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Switch" }).click();
  expect((await forgedSwitch).postData()).toContain(tenantB);
  await reloaded;
  // The action did not store the forged company: the cookie still names the user's own.
  const stored = (await context.cookies()).find((cookie) => cookie.name === "active_tenant");
  expect(stored?.value).toBe(tenantA);
  await expect(page.getByTestId("company-name")).toHaveText(ALPHA);
  await expect(page.getByText(BETA)).toHaveCount(0);
  await page.goto("/settings/branches");
  await expect(page.getByText("Beta Lahore")).toHaveCount(0);
});

test("the invite action refuses a branch that belongs to another company", async ({ page }) => {
  const email = emailFor("forged-invite");
  await signIn(page, ownerA);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Role").selectOption({ label: "Auditor" });
  await page.getByLabel("Only these").check();
  await expect(page.getByRole("button", { name: "Invite" })).toBeEnabled();
  // A branch id from the other company, added to the form the way a tampered request would.
  await page.getByLabel("Role").evaluate((field, forged) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "branchIds";
    input.value = forged;
    (field as HTMLSelectElement).form!.append(input);
  }, betaBranchId);
  const forgedInvite = page.waitForRequest(isServerAction);
  await page.getByRole("button", { name: "Invite" }).click();
  expect((await forgedInvite).postData()).toContain(betaBranchId);

  await expect(page.getByTestId("form-error")).toHaveText("Choose branches from this company.");
  const stored = await sql`select 1 from public.invitations where email = ${email}`;
  expect(stored).toHaveLength(0);
});

test("signing in and out writes audit rows the owner can read", async ({ page }) => {
  await signIn(page, ownerA);
  const before = await auditCount(tenantA, "auth.sign_in", ownerA.id);
  expect(before).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/settings/branches");
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(await auditCount(tenantA, "auth.sign_out", ownerA.id)).toBeGreaterThan(0);

  await signIn(page, ownerA);
  expect(await auditCount(tenantA, "auth.sign_in", ownerA.id)).toBe(before + 1);

  await page.goto("/settings/activity");
  const signIns = page.getByRole("table", { name: "Activity" }).getByRole("row").filter({ hasText: "Signed in" });
  await expect(signIns.first()).toContainText(ownerA.email);
  await expect(signIns.first()).toContainText("Owner");
});

test("an invited member chooses a password and sees only the branch they were given", async ({ page, browser, baseURL }) => {
  const email = emailFor("member-a");
  await signIn(page, ownerA);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Role").selectOption({ label: "Salesperson" });
  await page.getByLabel("Only these").check();
  await page.getByLabel("Alpha Karachi").check();
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("list", { name: "Pending invitations" })).toContainText(email);
  expect(await auditCount(tenantA, "member.invite", ownerA.id)).toBe(1);

  // What `npm run invites:send` does, for this company only and with the link generated
  // instead of emailed.
  let inviteUrl = "";
  const results = await sendPendingInvitations({
    sql,
    tenantIds: [tenantA],
    inviteUser: async (address: string) => {
      const link = await emailLink("invite", address, baseURL!);
      inviteUrl = link.url;
      return link.userId;
    },
  });
  expect(results.map((r) => r.outcome)).toEqual(["invited"]);
  expect(await auditCount(tenantA, "member.add", null)).toBe(1);

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  const password = randomPassword();
  await member.goto(inviteUrl);
  // The link says whose account it is and signs in only after Continue.
  await expect(member.getByText(`This link signs you in as ${email}.`)).toBeVisible();
  await expect(member).toHaveURL(/\/auth\/confirm$/);
  await member.getByRole("button", { name: "Continue" }).click();
  await expect(member).toHaveURL(/\/reset-password$/);
  await expect(member.getByText(`For ${email}`)).toBeVisible();
  await member.getByLabel("New password").fill(password);
  await member.getByLabel("Type it again").fill(password);
  await member.getByRole("button", { name: "Save password" }).click();

  await expect(member.getByTestId("company-name")).toHaveText(ALPHA);
  await expect(member.getByText(`Signed in as ${email}, Salesperson at ${ALPHA}.`)).toBeVisible();
  await expect(member.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(member.getByRole("link", { name: "New company" })).toHaveCount(0);

  await member.goto("/settings/branches");
  await expect(member.getByRole("list", { name: "Branches" }).getByRole("listitem")).toHaveText(["Alpha Karachi"]);
  await expect(member.getByRole("button", { name: "Add branch" })).toHaveCount(0);
  await member.goto("/settings/members");
  await expect(member.getByText("Only an owner or an auditor can see the members.")).toBeVisible();
  await member.goto("/settings/activity");
  await expect(member.getByText("Only an owner or an auditor can see the activity log.")).toBeVisible();
  await member.goto("/create-company");
  await expect(member.getByText("Your account cannot create a company.")).toBeVisible();
  await memberContext.close();

  // The owner now sees the member, and the invitation is no longer waiting.
  await page.goto("/settings/members");
  const row = page.getByRole("table", { name: "Members" }).getByRole("row").filter({ hasText: email });
  await expect(row).toContainText("Salesperson");
  await expect(row).toContainText("Alpha Karachi");
  await expect(page.getByRole("list", { name: "Pending invitations" })).toHaveCount(0);
});

test("someone who already has an account is not added to a company behind their back", async ({ page }) => {
  await signIn(page, ownerA);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill(ownerB.email);
  await page.getByLabel("Role").selectOption({ label: "Accountant" });
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("list", { name: "Pending invitations" })).toContainText(ownerB.email);

  const results = await sendPendingInvitations({
    sql,
    tenantIds: [tenantA],
    inviteUser: async () => {
      throw new Error("an existing account must not be invited again");
    },
  });
  expect(results.map((r) => r.outcome)).toEqual(["needs_consent"]);

  const added = await sql`select 1 from public.memberships where tenant_id = ${tenantA} and user_id = ${ownerB.id}`;
  expect(added).toHaveLength(0);
  expect(await auditCount(tenantA, "member.add", null)).toBe(1);
  await page.reload();
  await expect(page.getByRole("list", { name: "Pending invitations" })).toContainText(ownerB.email);
  await expect(page.getByRole("table", { name: "Members" }).getByText(ownerB.email)).toHaveCount(0);
});

test("a reset link sets a new password, works once, and the old password stops working", async ({ page, browser, baseURL }) => {
  const link = await emailLink("recovery", ownerB.email, baseURL!);
  const newPassword = randomPassword();

  await page.goto(link.url);
  await expect(page.getByText(`This link signs you in as ${ownerB.email}.`)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByText(`For ${ownerB.email}`)).toBeVisible();

  await page.getByLabel("New password").fill(newPassword);
  await page.getByLabel("Type it again").fill(`${newPassword}x`);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("The two passwords do not match.");

  await page.getByLabel("Type it again").fill(newPassword);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByTestId("company-name")).toHaveText(BETA);
  expect(await auditCount(tenantB, "auth.password_set", ownerB.id)).toBe(1);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  // The link cannot be used a second time.
  const second = await browser.newContext();
  const replay = await second.newPage();
  await replay.goto(link.url);
  await expect(replay).toHaveURL(/\/auth\/confirm$/);
  await expect(replay.getByTestId("form-error")).toHaveText("This link has expired or was already used. Ask for a new one.");
  await second.close();

  await page.getByLabel("Email").fill(ownerB.email);
  await page.getByLabel("Password").fill(ownerB.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("The email or password is not right.");

  await signIn(page, { email: ownerB.email, password: newPassword });
  await expect(page.getByTestId("company-name")).toHaveText(BETA);
});
