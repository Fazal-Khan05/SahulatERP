import { redirect } from "next/navigation";

// Collections (the owner's and the sales manager's menu entry) leads here, and covers every page
// under /recovery; the list it opens on is the overdue customers.
export default function RecoveryPage() {
  redirect("/recovery/overdue");
}
