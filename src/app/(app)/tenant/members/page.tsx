import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/page-loading";
import { requireTenant } from "@/lib/auth/session";
import { listBranches, listMembers, listPendingInvitations } from "@/modules/tenant/queries";
import { MEMBER_ROLES, ROLE_LABELS, can } from "@/modules/tenant/rules";
import { inviteMemberAction } from "../actions";

export const metadata: Metadata = { title: "Members — SahulatERP" };

// The session and the rows are read at request time, behind the boundary, so moving between
// pages shows the frame at once and the content as soon as it is ready.
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
    return (
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-medium">Members</h1>
        <p className="text-sm text-muted-foreground">Only an owner can see the members.</p>
      </section>
    );
  }

  const [members, pending, branches] = await Promise.all([
    listMembers(session),
    listPendingInvitations(session),
    listBranches(session),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const scope = (ids: string[] | null) =>
    ids === null ? "Every branch" : ids.map((id) => branchName.get(id) ?? "Unknown branch").join(", ") || "No branch";

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-medium">Members</h1>
        <p className="text-sm text-muted-foreground">People who can sign in to {session.tenantName}.</p>
      </div>

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

      {pending.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h2 className="font-medium">Invitations waiting to be sent</h2>
          <ul aria-label="Pending invitations" className="divide-y rounded-xl border text-sm">
            {pending.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap gap-x-4 px-4 py-2.5">
                <span>{invitation.email}</span>
                <span className="text-muted-foreground">{ROLE_LABELS[invitation.role]}</span>
                <span className="text-muted-foreground">{scope(invitation.branchIds)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="max-w-sm">
        <h2 className="mb-3 font-medium">Invite a member</h2>
        <ActionForm action={inviteMemberAction} submitLabel="Invite">
          <Field label="Email" name="email" type="email" required />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="role">Role</Label>
            <select
              id="role"
              name="role"
              required
              defaultValue=""
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
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
      </div>
    </section>
  );
}
