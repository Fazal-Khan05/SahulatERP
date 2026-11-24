import "server-only";
import type { TenantSession } from "@/lib/auth/session";
import { UserError } from "@/lib/errors";
import { getReturnStanding, type ReturnStanding } from "@/modules/tax-return/queries";

/**
 * Whether this member may open the return and whether the company files one: the reason it is
 * not shown, in words, or the company's standing.
 */
export async function openReturn(session: TenantSession): Promise<{ refused: string } | { standing: ReturnStanding }> {
  try {
    const standing = await getReturnStanding(session);
    if (!standing.registered) return { refused: "This company is not registered for sales tax, so it files no sales tax return." };
    return { standing };
  } catch (error) {
    if (error instanceof UserError) return { refused: error.message };
    throw error;
  }
}
