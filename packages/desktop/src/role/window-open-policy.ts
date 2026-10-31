/**
 * What a `window.open` / `target=_blank` from the viewer window becomes.
 *
 * Pure — the Electron wiring lives in `viewer-window.ts`. The sign-in page
 * opens the SSO flow in a popup and waits for it to `postMessage` back to
 * `window.opener`, so that popup must stay a child window of THIS session
 * (the IdP hop included); anything else that leaves the hub goes to the
 * system browser rather than a window that inherits the preload bridge.
 */

/** The window name the admin UI gives its SSO popup (`SSO_POPUP_NAME`). */
export const SSO_POPUP_WINDOW_NAME = 'camstack-sso'

export type WindowOpenDecision =
  /** A child window in the hub's partition, WITHOUT the preload bridge. */
  | { readonly action: 'child' }
  /** The system browser. */
  | { readonly action: 'external'; readonly url: string }
  | { readonly action: 'deny' }

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Classify one window-open request.
 *
 * - `about:blank` (the popup is opened blank, then navigated) and any URL on
 *   the hub origin → child window;
 * - the SSO popup's window name → child window, whatever the URL: the IdP
 *   must stay in the popup for the callback to return to the opener;
 * - any other http(s) URL → the system browser;
 * - everything else (`file:`, `javascript:`, malformed…) → denied.
 */
export function classifyWindowOpen(
  url: string,
  hubOrigin: string,
  frameName: string = '',
): WindowOpenDecision {
  if (url === 'about:blank') return { action: 'child' }
  if (frameName === SSO_POPUP_WINDOW_NAME) {
    return /^https?:\/\//i.test(url) ? { action: 'child' } : { action: 'deny' }
  }
  const origin = originOf(url)
  if (origin === null) return { action: 'deny' }
  if (origin === hubOrigin) return { action: 'child' }
  if (/^https?:\/\//i.test(url)) return { action: 'external', url }
  return { action: 'deny' }
}
