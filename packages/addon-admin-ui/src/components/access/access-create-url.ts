/**
 * URL keys for credential create dialogs on Identity → Tokens & sessions.
 *
 * Kind-specific (not `?new=1`) so they never collide with Users' create/edit
 * on the same Identity strip. Cleared when leaving the Access tab via
 * `ownedParams` in `Identity.tsx`.
 */
export const ACCESS_CREATE_URL_KEYS = {
  /** Merged Tokens create dialog (`?newToken=1`). */
  token: 'newToken',
  /** Legacy keys — still cleared on leave; redirects open `token`. */
  scoped: 'newScoped',
  admin: 'newAdmin',
} as const
