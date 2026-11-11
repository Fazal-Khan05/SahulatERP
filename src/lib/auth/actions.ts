"use server";

import { logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recordAuthEvent } from "@/modules/tenant/commands";
import { getSessionUser } from "./session";

export async function signOutAction(): Promise<FormState> {
  const user = await getSessionUser();
  if (user) {
    try {
      await recordAuthEvent(user.id, "auth.sign_out");
    } catch (error) {
      // Signing out must always work; the failure is logged and the session still ends.
      logFailure("sign-out audit", error);
    }
  }
  const supabase = await createSupabaseServerClient();
  // "local" removes this browser's session before anything is sent, so signing out never depends
  // on the network, and other devices stay signed in.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) logFailure(`sign-out (${error.code ?? "unknown"})`, error);
  return { location: "/sign-in" };
}
