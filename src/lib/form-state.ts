/** What a form's server action hands back to the form. */
export type FormState = {
  /** Shown in red; the form keeps what was typed. */
  error?: string;
  /** Shown as a neutral note. */
  message?: string;
  /** True when the action succeeded and the form should clear. */
  ok?: boolean;
  /**
   * Where to go next, as a full page load. Used whenever the signed-in user or the selected
   * company changes, so nothing the browser cached for the previous one can be shown again.
   */
  location?: string;
};
