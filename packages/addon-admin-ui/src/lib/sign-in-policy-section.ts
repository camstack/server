/**
 * The hub-wide sign-in policy (token lifetimes, trusted proxies, trusted
 * networks, allowed browser origins). It is a section of the `system-config`
 * bootstrap form, and Identity → Authentication is the only surface that
 * draws it. System → Settings renders that form with no section list, so the
 * form leaves this id out on its own.
 */
export const SIGN_IN_POLICY_SECTION_ID = 'system-config-auth'
