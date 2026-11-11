// npm run invites:send -- --url=https://sahulaterp.vercel.app
//
// Sends the invitations owners recorded in the app: creates each account through Supabase Auth
// (which emails the invite link) and adds the membership. Safe to run again at any time.
import { adminSql, emailLinkBase, maskEmail, supabaseAdmin } from "./lib/admin.mjs";
import { sendPendingInvitations } from "./lib/invitations.mjs";

const base = emailLinkBase(process.argv.slice(2));
const supabase = supabaseAdmin();
const sql = adminSql();

try {
  const results = await sendPendingInvitations({
    sql,
    inviteUser: async (email) => {
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo: `${base}/auth/confirm` });
      if (error || !data.user) throw new Error(error?.message ?? "Supabase Auth returned no user");
      return data.user.id;
    },
  });

  if (results.length === 0) console.log("No invitations are waiting.");
  for (const result of results) {
    const who = maskEmail(result.email);
    if (result.outcome === "invited") console.log(`Invited ${who}: email sent, link opens ${base}`);
    if (result.outcome === "resumed") console.log(`Finished ${who}: invited by an earlier run, no second email sent`);
    if (result.outcome === "needs_consent") {
      console.log(`Left waiting ${who}: already has an account, and nobody is added to a company without accepting`);
    }
    if (result.outcome === "failed") console.log(`Failed ${who}: ${result.reason} (still waiting; run again later)`);
  }
  process.exitCode = results.some((r) => r.outcome === "failed") ? 1 : 0;
} finally {
  await sql.end();
}
