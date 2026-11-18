// npm run two-step:remove -- member@example.com --yes
//
// For a member who has lost the phone with their authenticator app (Step 47). Removes the app
// from their account, so the next sign-in asks for the password only and then offers the setup
// again (which an owner or accountant must go through before going on). A session that already
// gave a code runs on until it ends (at most an hour without use, twelve hours in all). Each
// company they belong to gets a row in its sign-in history.
//
// Only after making sure, outside the app, that the request comes from the member themself:
// whoever can run this can take away the second step of anyone's sign-in. Without --yes it only
// says what it would do.
import { EMAIL, adminSql, maskEmail, supabaseAdmin } from "./lib/admin.mjs";

const args = process.argv.slice(2);
const email = args.find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();
const really = args.includes("--yes");
if (!email || !EMAIL.test(email)) {
  console.error("Usage: npm run two-step:remove -- member@example.com --yes");
  process.exit(1);
}

const supabase = supabaseAdmin();
const sql = adminSql();

try {
  const [account] = await sql`select id from auth.users where lower(email) = ${email}`;
  if (!account) {
    console.error(`No account for ${maskEmail(email)}.`);
    process.exit(1);
  }
  const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId: account.id });
  if (error) {
    console.error(`Could not list the account's sign-in apps: ${error.message}`);
    process.exit(1);
  }
  const apps = data.factors.filter((f) => f.factor_type === "totp");
  if (apps.length === 0) {
    console.log(`${maskEmail(email)} has no authenticator app; nothing to do.`);
    process.exit(0);
  }
  if (!really) {
    console.log(`${maskEmail(email)} has ${apps.length} authenticator app(s). Run again with --yes to remove them.`);
    process.exit(0);
  }

  for (const app of apps) {
    const { error: removeError } = await supabase.auth.admin.mfa.deleteFactor({ id: app.id, userId: account.id });
    if (removeError) {
      console.error(`Could not remove an authenticator app: ${removeError.message}`);
      process.exit(1);
    }
  }
  // Written by the system, not by a member: no actor.
  const companies = await sql`
    insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
    select m.tenant_id, null, null, 'auth.two_step_reset', 'user', ${account.id}, ${sql.json({ by: "support" })}
    from public.memberships m where m.user_id = ${account.id} and m.active
    returning tenant_id`;
  console.log(
    `Removed the authenticator app of ${maskEmail(email)} and recorded it in ${companies.length} compan${companies.length === 1 ? "y" : "ies"}.`,
  );
} finally {
  await sql.end();
}
