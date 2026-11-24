import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { getBankFile } from "@/modules/staff-loans/queries";
import { can } from "@/modules/tenant/rules";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

// Step 42. The salary bank file of an approved or paid run, for whoever prepares or makes the
// payment, across the whole company: a member kept to some branches would get a file paying only
// some of the people. Anyone else, a run of another company or one not approved, is not found.
export async function GET(_: Request, { params }: RouteContext<"/payroll/runs/[id]/bank-file">) {
  const { id } = await params;
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.payroll || session.branchIds !== null || !(can(session.role, "payroll.manage") || can(session.role, "payroll_run.pay"))) return plain(404, "Not found");
  try {
    const file = await getBankFile(session, id);
    if (!file) return plain(404, "Not found");
    if ("missing" in file) return plain(409, `No bank account is on record for ${file.missing.map((m) => `${m.code} ${m.name}`).join(", ")}. Add each one on their page first.`);
    if ("problems" in file) return plain(409, `A bank would refuse this file: ${file.problems.join(" ")}`);
    return new Response(file.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UserError) return plain(404, "Not found");
    logFailure("salary bank file", error);
    return plain(500, "The bank file could not be made. Try again.");
  }
}
