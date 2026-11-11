// Turns the invitations owners recorded in the app into accounts and memberships.
//
// The invitation row is the recorded intent. For each pending one: look the address up first, so
// a re-run after a half-finished attempt never invites the same person twice; create the account
// only if there is none; then add the membership, mark the invitation sent and write the audit
// row in one transaction.
//
// Someone who already has an account is never added to a company behind their back: an owner
// could otherwise attach any person to their company just by knowing the email address. Such an
// invitation stays pending until the app has a way for that person to accept it.

/**
 * @param {object} options
 * @param {import("postgres").Sql} options.sql        Connection as postgres (bypasses row-level security).
 * @param {(email: string) => Promise<string>} options.inviteUser  Creates the account and returns its user id.
 *        Called only when the address has no account yet.
 * @param {string[] | null} [options.tenantIds]       Limit to these companies; null = every company.
 * @returns {Promise<{ id: string, email: string, outcome: "invited" | "resumed" | "needs_consent" | "failed", reason?: string }[]>}
 */
export async function sendPendingInvitations({ sql, inviteUser, tenantIds = null }) {
  const pending = await sql`
    select id, tenant_id, email, role, branch_ids, created_by, user_id
    from public.invitations
    where status = 'pending' ${tenantIds ? sql`and tenant_id = any(${tenantIds})` : sql``}
    order by created_at`;

  const results = [];
  for (const invitation of pending) {
    try {
      const [account] = await sql`select id from auth.users where lower(email) = ${invitation.email}`;
      // An existing account is ours to finish only if this very invitation created it (an
      // earlier run that stopped before the membership was written).
      if (account && account.id !== invitation.user_id) {
        results.push({ id: invitation.id, email: invitation.email, outcome: "needs_consent" });
        continue;
      }
      const userId = account?.id ?? (await inviteUser(invitation.email));
      if (!account) {
        // Remember which account this invitation created before doing anything else with it.
        await sql`update public.invitations set user_id = ${userId} where id = ${invitation.id} and status = 'pending'`;
      }

      await sql.begin(async (tx) => {
        const [current] = await tx`select status from public.invitations where id = ${invitation.id} for update`;
        if (current?.status !== "pending") return;
        await tx`
          insert into public.memberships (tenant_id, user_id, email, role, branch_ids, created_by)
          values (${invitation.tenant_id}, ${userId}, ${invitation.email}, ${invitation.role},
                  ${invitation.branch_ids}, ${invitation.created_by})`;
        await tx`
          update public.invitations set status = 'sent', sent_at = now(), user_id = ${userId}
          where id = ${invitation.id}`;
        // Written by the system: no actor.
        await tx`
          insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, after)
          values (${invitation.tenant_id}, null, null, 'member.add', 'membership', ${userId},
                  ${tx.json({ email: invitation.email, role: invitation.role, invitation_id: invitation.id })})`;
      });
      results.push({ id: invitation.id, email: invitation.email, outcome: account ? "resumed" : "invited" });
    } catch (error) {
      results.push({
        id: invitation.id,
        email: invitation.email,
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
