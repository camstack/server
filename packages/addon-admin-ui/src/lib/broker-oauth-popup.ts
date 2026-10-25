/**
 * Browser consent for a broker that advertises `interactiveConnectPath`
 * (Google OAuth, …). Same popup shape as OIDC (D794): open with `popup=1`,
 * the addon callback page postMessages the opener and closes.
 *
 * Message contract (addon HTML → opener):
 *   `{ type: 'camstack:broker-oauth', ok: boolean, brokerId?: string, error?: string }`
 *
 * Admin-ui never branches on kind/addonId — it only opens whatever path
 * `broker.listProviders` returned for that kind.
 */
import { hubPath } from './mount'
import { openSsoPopup, withPopupFlag } from './sso-popup'

export const BROKER_OAUTH_MESSAGE = 'camstack:broker-oauth' as const

export interface BrokerOauthResult {
  readonly ok: boolean
  readonly brokerId?: string
  readonly error?: string
}

interface BrokerOauthMessage {
  readonly type: typeof BROKER_OAUTH_MESSAGE
  readonly ok: boolean
  readonly brokerId?: string
  readonly error?: string
}

function isBrokerOauthMessage(data: unknown): data is BrokerOauthMessage {
  if (typeof data !== 'object' || data === null) return false
  const v = data as Record<string, unknown>
  return v['type'] === BROKER_OAUTH_MESSAGE && typeof v['ok'] === 'boolean'
}

/** Fill `{{brokerId}}` in a provider-advertised path template. */
export function fillBrokerConnectPath(template: string, brokerId: string): string {
  return template.split('{{brokerId}}').join(encodeURIComponent(brokerId))
}

/**
 * Wait for the popup's postMessage, or for the window to close (treat as done
 * so the list can refresh either way). Returns an unsubscribe.
 */
export function watchBrokerOauthPopup(
  popup: Window,
  onResult: (result: BrokerOauthResult) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'> = window,
): () => void {
  const ownOrigin = target.location.origin // hub-path-ok: postMessage sender check against this page (the popup opens on the same origin), not a server base
  let settled = false

  const finish = (result: BrokerOauthResult): void => {
    if (settled) return
    settled = true
    target.removeEventListener('message', listener)
    window.clearInterval(poll)
    onResult(result)
  }

  const listener = (event: MessageEvent): void => {
    if (event.origin !== ownOrigin || event.source !== popup) return
    if (!isBrokerOauthMessage(event.data)) return
    finish({
      ok: event.data.ok,
      ...(event.data.brokerId !== undefined ? { brokerId: event.data.brokerId } : {}),
      ...(event.data.error !== undefined ? { error: event.data.error } : {}),
    })
  }
  target.addEventListener('message', listener)

  const poll = window.setInterval(() => {
    if (!popup.closed) return
    finish({ ok: true })
  }, 500)

  return () => {
    settled = true
    target.removeEventListener('message', listener)
    window.clearInterval(poll)
  }
}

/** What {@link startServerNavigation} touches in the browser; injectable for tests. */
export interface ServerNavigationEnv {
  readonly open: (url: string) => Window | null
  readonly assign: (url: string) => void
  readonly watch: (popup: Window, onResult: (result: BrokerOauthResult) => void) => () => void
}

const BROWSER_ENV: ServerNavigationEnv = {
  open: (url) => openSsoPopup(url),
  assign: (url) => window.location.assign(url),
  watch: (popup, onResult) => watchBrokerOauthPopup(popup, onResult),
}

/**
 * Follow a route the HUB serves (an addon HTTP route — an OAuth start), which
 * the admin SPA has no page for: a router link would fall through to the
 * catch-all and land on the home page. Popup preferred (`popup=1`; the
 * completion page hands the outcome back and closes it); a blocked popup — a
 * PWA, a strict browser — falls back to a full-page navigation, which ends on
 * the same completion page in this window. `onSettled` runs when the popup
 * finishes (or closes) so the caller can refresh what the flow changed.
 */
export function startServerNavigation(
  hubRelativePath: string,
  onSettled?: (result: BrokerOauthResult) => void,
  env: ServerNavigationEnv = BROWSER_ENV,
): void {
  const url = hubPath(withPopupFlag(hubRelativePath))
  const popup = env.open(url)
  if (popup === null) {
    env.assign(url)
    return
  }
  env.watch(popup, (result) => {
    onSettled?.(result)
  })
}

/**
 * Start interactive connect: popup preferred (`openSsoPopup` + `popup=1`);
 * full-page navigate if blocked. `onSettled` runs when the popup finishes
 * (or closes) so the caller can invalidate broker list queries.
 */
export function startBrokerInteractiveConnect(
  pathTemplate: string,
  brokerId: string,
  onSettled?: (result: BrokerOauthResult) => void,
): void {
  startServerNavigation(fillBrokerConnectPath(pathTemplate, brokerId), onSettled)
}
