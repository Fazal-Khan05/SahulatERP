import type { Metadata } from "next";
import Link from "next/link";
import { confirmSessionAction, inspectLinkAction } from "../../actions";
import { ConfirmLink } from "./confirm-link";

export const metadata: Metadata = { title: "Confirm — SahulatERP" };

// Invite and password-reset emails land here.
export default function ConfirmPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Choose your password</h1>
      <ConfirmLink inspect={inspectLinkAction} confirm={confirmSessionAction} />
      <Link href="/sign-in" className="text-sm text-muted-foreground underline underline-offset-4">
        Back to sign in
      </Link>
    </div>
  );
}
