import type { TenantSession } from "@/lib/auth/session";

// "Needs attention" is one list, filled from three files: one for each track being built in
// parallel (docs/PARALLEL.md). A track puts work into the list by returning it from its own
// file here; nobody edits the page or another track's file.

/** One thing waiting on the person signed in. */
export type InboxItem = {
  /** Unlike every other item in the list. */
  key: string;
  /** The screen where the person deals with it. */
  href: string;
  /** What to do and about what: "Approve or send back: sales order for Karachi Motors". */
  title: string;
  /** The figures that matter, in a few words. */
  detail: string;
};

/** What a track's file exports: everything of its own that waits on this person, oldest first. */
export type InboxSource = (session: TenantSession) => Promise<InboxItem[]>;
