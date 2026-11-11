"use client";

import { useEffect } from "react";

/**
 * An auth email sent without a redirect (for example from the Supabase dashboard) opens the site
 * root instead of /auth/confirm. Wherever such a link lands, pass it on.
 */
export function EmailLinkCatcher() {
  useEffect(() => {
    const { hash, pathname } = window.location;
    if (pathname !== "/auth/confirm" && /[#&](access_token|error_code)=/.test(hash)) {
      window.location.replace(`/auth/confirm${hash}`);
    }
  }, []);
  return null;
}
