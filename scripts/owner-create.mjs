// npm run owner:create -- owner@example.com --url=https://sahulaterp.vercel.app
//
// Invites the first user of a new company. There is no public sign-up: this is how an owner gets
// an account. Supabase Auth emails them a link to choose a password; on first sign-in they create
// their company. If the address already has an account it is only given the right to create one.
import { EMAIL, adminSql, emailLinkBase, maskEmail, supabaseAdmin } from "./lib/admin.mjs";

const args = process.argv.slice(2);
const email = args.find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();
if (!email || !EMAIL.test(email)) {
  console.error("Usage: npm run owner:create -- owner@example.com --url=https://sahulaterp.vercel.app");
  process.exit(1);
}

const base = emailLinkBase(args);
const supabase = supabaseAdmin();
const sql = adminSql();

try {
  // Look first, so running this twice never sends a second invite.
  const [account] = await sql`select id from auth.users where lower(email) = ${email}`;
  let userId = account?.id;
  if (!userId) {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo: `${base}/auth/confirm` });
    if (error || !data.user) {
      console.error(`Could not invite ${maskEmail(email)}: ${error?.message ?? "Supabase Auth returned no user"}`);
      process.exit(1);
    }
    userId = data.user.id;
  }

  const { error } = await supabase.auth.admin.updateUserById(userId, { app_metadata: { can_create_company: true } });
  if (error) {
    console.error(`The account exists but could not be allowed to create a company: ${error.message}`);
    process.exit(1);
  }

  console.log(
    account
      ? `${maskEmail(email)} already had an account. It can now create a company after signing in.`
      : `Invited ${maskEmail(email)}. The email link opens ${base} and lets them choose a password.`,
  );
} finally {
  await sql.end();
}
