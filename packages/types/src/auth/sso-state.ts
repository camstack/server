/**
 * The cookie that binds an SSO sign-in to the browser that started it.
 *
 * An IdP `/start` sets it to a random value and keeps only its SHA-256 in the
 * server-side pending state; the login bridge carries that hash. The hub's
 * `/api/auth/sso/finish` swaps a bridge for a session only when the request
 * presents the cookie whose hash the bridge names — so a bridge copied out of
 * a URL (history, a proxy log, a screenshot) is useless in any other browser.
 * The finish clears the cookie, and records the bridge's `jti` so the same
 * bridge never finishes twice.
 *
 * One name, two readers (the OIDC addon that sets it, the hub that checks it).
 */
export const SSO_STATE_COOKIE = 'camstack_sso_state'

/** Seconds the state cookie lives — the pending IdP state lasts 5 minutes, the bridge 5 more. */
export const SSO_STATE_COOKIE_MAX_AGE_SEC = 600
