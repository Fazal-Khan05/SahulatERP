import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { listBranches, listMembers, listPendingInvitations } from "@/modules/tenant/queries";
import { MEMBER_ROLES, ROLE_LABELS, can } from "@/modules/tenant/rules";
import { inviteMemberAction } from "../actions";

export const metadata: Metadata = { title: "Members" };

export default function MembersPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Members />
    </Suspense>
  );
}

async function Members() {
  const session = await requireTenant();
  if (!can(session.role, "member.read")) {
    return <p className="text-muted-foreground">Only an owner or an auditor can see the members.</p>;
  }

  // Invitations belong to the owner who sends them; an auditor sees the members only.
  const [members, pending, branches] = await Promise.all([
    listMembers(session),
    can(session.role, "member.invite") ? listPendingInvitations(session) : [],
    listBranches(session),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const scope = (ids: string[] | null) =>
    ids === null ? "Every branch" : ids.map((id) => branchName.get(id) ?? "Unknown branch").join(", ") || "No branch";

  return (
    <div className="flex flex-col gap-5">
      <Card title="Members">
        <p className="mb-2 text-sm text-muted-foreground">People who can sign in to {session.tenantName}.</p>
        <div className="overflow-x-auto">
          <table aria-label="Members" className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Email</th>
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 pr-4 font-medium">Branches</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {members.map((member) => (
                <tr key={member.userId}>
                  <td className="py-2 pr-4">{member.email}</td>
                  <td className="py-2 pr-4">{ROLE_LABELS[member.role]}</td>
                  <td className="py-2 pr-4">{scope(member.branchIds)}</td>
                  <td className="py-2">{member.active ? "Active" : "Inactive"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {pending.length > 0 ? (
        <Card title="Invitations waiting to be sent">
          <ul aria-label="Pending invitations" className="divide-y text-sm">
            {pending.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap gap-x-4 py-2.5">
                <span>{invitation.email}</span>
                <span className="text-muted-foreground">{ROLE_LABELS[invitation.role]}</span>
                <span className="text-muted-foreground">{scope(invitation.branchIds)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {can(session.role, "member.invite") ? (
        <Card title="Invite a member" className="max-w-xl">
          <ActionForm action={inviteMemberAction} submitLabel="Invite">
            <Field label="Email" name="email" type="email" required />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role">Role</Label>
              <select
                id="role"
                name="role"
                required
                defaultValue=""
                className="h-8 rounded-lg border border-input bg-card px-2 text-sm"
              >
                <option value="" disabled>
                  Choose a role
                </option>
                {MEMBER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1.5 font-medium">Branches</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" value="all" defaultChecked />
                Every branch
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" value="some" disabled={branches.length === 0} />
                Only these
              </label>
              {branches.map((branch) => (
                <label key={branch.id} className="ml-6 flex items-center gap-2">
                  <input type="checkbox" name="branchIds" value={branch.id} />
                  {branch.name}
                </label>
              ))}
            </fieldset>
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
