/**
 * Run an SSO sign-in or link in a popup window instead of navigating the page
 * away (D791).
 *
 *   opener                         popup
 *   ──────                         ─────
 *   window.open(start?popup=1) ──▶ IdP … → callback → /api/auth/sso/finish?popup=1
 *                                  → /sso-complete#return=login|profile&…
 *   ◀── postMessage(completion, OWN origin)
 *   ack (to that popup only) ────▶ window.close()
 *
 * The completion travels ONLY by `postMessage` with the page's own origin as
 * `targetOrigin`, to `window.opener`; the opener accepts it only from the
 * popup it opened, at its own origin. Nothing goes to a BroadcastChannel or
 * storage — no other window reads a session token. The popup waits for the
 * opener's ack; with no opener, a navigated-away opener or no ack in time it
 * continues to the page the completion names (`/login#…`, `/system/my-access?…`)
 * — exactly the full-page return. A blocked popup falls back to navigating the
 * page itself.
 */

import { externalLinkNotice } from './sso-return'

export const SSO_POPUP_MESSAGE = 'camstack:sso-return'
export const SSO_POPUP_ACK = 'camstack:sso-ack'
/** Window name: a second click reuses the open popup instead of stacking a new one. */
export const SSO_POPUP_NAME = 'camstack-sso'
/** The admin-ui route the hub's SSO finish lands a popup on (`SSO_POPUP_COMPLETE_PATH`). */
export const SSO_POPUP_COMPLETE_ROUTE = '/sso-complete'
/** How long the popup waits for the opener's ack before completing in itself. */
export const SSO_POPUP_ACK_TIMEOUT_MS = 1500

const POPUP_WIDTH = 520
const POPUP_HEIGHT = 680

/** What the SSO finish handed the popup: the login fragment or the profile query, verbatim. */
export type SsoPopupCompletion =
  | { readonly target: 'login'; readonly fragment: string }
  | { readonly target: 'profile'; readonly query: string }

/** Parse `/sso-complete#return=login|profile&…`; `null` for anything else. */
export function parsePopupCompletion(hash: string): SsoPopupCompletion | null {
  if (!hash.startsWith('#')) return null
  const params = new URLSearchParams(hash.slice(1))
  const target = params.get('return')
  params.delete('return')
  const rest = params.toString()
  if (target === 'login') return rest.length > 0 ? { target, fragment: rest } : null
  if (target === 'profile') return rest.length > 0 ? { target, query: rest } : null
  return null
}

/** The full-page return the completion stands for (relative to the admin-ui mount). */
export function completionFallbackPath(completion: SsoPopupCompletion): string {
  return completion.target === 'login'
    ? `/login#${completion.fragment}`
    : `/system/my-access?${completion.query}`
}

/** `url` with `popup=1` added — a relative hub path stays relative. */
export function withPopupFlag(url: string): string {
  const parsed = new URL(url, 'http://placeholder.invalid')
  parsed.searchParams.set('popup', '1')
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(url)
  return isAbsolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** A small centred window with no toolbar, menu or location bar (where the browser honours it). */
export function popupFeatures(
  screenLike: {
    readonly screenX: number
    readonly screenY: number
    readonly outerWidth: number
    readonly outerHeight: number
  } = window,
): string {
  const left = Math.max(
    0,
    Math.round(screenLike.screenX + (screenLike.outerWidth - POPUP_WIDTH) / 2),
  )
  const top = Math.max(
    0,
    Math.round(screenLike.screenY + (screenLike.outerHeight - POPUP_HEIGHT) / 2),
  )
  return [
    'popup=yes',
    `width=${POPUP_WIDTH}`,
    `height=${POPUP_HEIGHT}`,
    `left=${left}`,
    `top=${top}`,
    'toolbar=no',
    'menubar=no',
    'location=no',
    'status=no',
    'resizable=yes',
    'scrollbars=yes',
  ].join(',')
}

/**
 * Open the SSO popup — at `url`, or blank when the start URL is not known yet
 * (it comes from a mutation; opening later than the click is what a popup
 * blocker blocks). `null` = blocked: the caller navigates the page instead.
 * Never `noopener`: the popup needs `window.opener` to hand the outcome back.
 */
export function openSsoPopup(url: string | null): Window | null {
  try {
    // `?? null`: some environments answer `undefined` rather than `null`.
    return window.open(url ?? 'about:blank', SSO_POPUP_NAME, popupFeatures()) ?? null
  } catch {
    return null
  }
}

interface PopupReturnMessage {
  readonly type: typeof SSO_POPUP_MESSAGE
  readonly completion: SsoPopupCompletion
}

function isCompletion(value: unknown): value is SsoPopupCompletion {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v['target'] === 'login') return typeof v['fragment'] === 'string'
  if (v['target'] === 'profile') return typeof v['query'] === 'string'
  return false
}

function isReturnMessage(data: unknown): data is PopupReturnMessage {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return d['type'] === SSO_POPUP_MESSAGE && isCompletion(d['completion'])
}

/**
 * The completion in `event`, when — and only when — it comes from `popup`
 * (the window this page opened) at `ownOrigin`. Anything else is ignored.
 */
export function trustedPopupCompletion(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  popup: Window | null,
  ownOrigin: string,
): SsoPopupCompletion | null {
  if (popup === null || event.source !== popup) return null
  if (event.origin !== ownOrigin) return null
  return isReturnMessage(event.data) ? event.data.completion : null
}

/**
 * A same-origin channel between the popup and the window that opened it, for
 * when the `window.opener` reference is gone (a `Cross-Origin-Opener-Policy`
 * on any page of the IdP hop severs it). It carries only a "done" signal —
 * NEVER a session or challenge token: every same-origin tab can read it.
 */
export interface SsoChannel {
  post(data: unknown): void
  subscribe(listener: (data: unknown) => void): () => void
}

/** The `BroadcastChannel` name of {@link SsoChannel}. */
export const SSO_POPUP_CHANNEL = 'camstack-sso'
/** Popup → opener on the channel: the flow finished (no token in it). */
export const SSO_POPUP_DONE = 'camstack:sso-done'
/** Opener → popup on the channel: taken — the popup may close. */
export const SSO_POPUP_DONE_ACK = 'camstack:sso-done-ack'

/** What the channel says: a login finished (session stored at this origin), or a link's outcome. */
export type SsoDoneSignal =
  | { readonly target: 'login' }
  | { readonly target: 'profile'; readonly query: string }

/** The token-free signal for `completion`; `null` when it may not go on the channel. */
function doneSignalFor(completion: SsoPopupCompletion, hasSession: boolean): SsoDoneSignal | null {
  if (completion.target === 'profile') return { target: 'profile', query: completion.query }
  return hasSession ? { target: 'login' } : null
}

function parseDoneSignal(data: unknown): SsoDoneSignal | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d['type'] !== SSO_POPUP_DONE) return null
  const keys = Object.keys(d).sort().join(',')
  if (d['target'] === 'login' && keys === 'target,type') return { target: 'login' }
  if (d['target'] === 'profile' && typeof d['query'] === 'string' && keys === 'query,target,type') {
    return { target: 'profile', query: d['query'] }
  }
  return null
}

function isDoneAck(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === SSO_POPUP_DONE_ACK
  )
}

/** The origin of `win`, or `null` when it is at another origin (reading it throws). */
export function readableOrigin(win: Window): string | null {
  try {
    const origin = win.location.origin // hub-path-ok: same-origin probe, not a hub URL
    return typeof origin === 'string' ? origin : null
  } catch {
    return null
  }
}

/** The `BroadcastChannel`-backed {@link SsoChannel}, or `null` where there is none. */
export function openSsoChannel(): (SsoChannel & { close(): void }) | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    const bc = new BroadcastChannel(SSO_POPUP_CHANNEL)
    return {
      post: (data) => bc.postMessage(data),
      subscribe: (listener) => {
        const onMessage = (event: MessageEvent): void => listener(event.data)
        bc.addEventListener('message', onMessage)
        return () => bc.removeEventListener('message', onMessage)
      },
      close: () => bc.close(),
    }
  } catch {
    return null
  }
}

export interface SsoPopupHandlers {
  /** The popup handed back its completion by `postMessage` (same origin, opener intact). */
  readonly onReturn: (completion: SsoPopupCompletion) => void
  /** The popup signalled "done" on the same-origin channel (opener reference severed). */
  readonly onDone?: (signal: SsoDoneSignal) => void
  /** The popup closed — all a finish on ANOTHER origin can tell this window. Once. */
  readonly onClosed?: () => void
}

export interface SsoPopupWatchDeps {
  readonly channel?: SsoChannel | null
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

const POPUP_CLOSED_POLL_MS = 500

/**
 * Wait for `popup` to finish, on whichever path reaches this window:
 *  - its `postMessage` (acked to that window, at this origin) → `onReturn`;
 *  - a "done" on the same-origin channel (acked there) → `onDone`;
 *  - the window closing → `onClosed`.
 * `onReturn` / `onDone` fire at most once between them. Returns the unsubscribe.
 */
export function watchSsoPopup(
  popup: Window,
  handlers: SsoPopupHandlers,
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'> = window,
  deps: SsoPopupWatchDeps = {},
): () => void {
  const ownOrigin = target.location.origin // hub-path-ok: postMessage origin check, not a hub URL
  const ownChannel = deps.channel === undefined ? openSsoChannel() : null
  const channel = deps.channel === undefined ? ownChannel : deps.channel
  const setIntervalFn = deps.setInterval ?? ((fn, ms) => window.setInterval(fn, ms))
  const clearIntervalFn =
    deps.clearInterval ?? ((h) => window.clearInterval(h as ReturnType<typeof window.setInterval>))
  let returned = false
  let closedReported = false

  const listener = (event: MessageEvent): void => {
    const completion = trustedPopupCompletion(event, popup, ownOrigin)
    if (completion === null || returned) return
    returned = true
    target.removeEventListener('message', listener)
    popup.postMessage({ type: SSO_POPUP_ACK }, ownOrigin)
    handlers.onReturn(completion)
  }
  target.addEventListener('message', listener)

  const unsubscribeChannel =
    channel?.subscribe((data) => {
      const signal = parseDoneSignal(data)
      if (signal === null || returned) return
      returned = true
      channel.post({ type: SSO_POPUP_DONE_ACK })
      handlers.onDone?.(signal)
    }) ?? null

  const poll = setIntervalFn(() => {
    if (closedReported || !popup.closed) return
    closedReported = true
    clearIntervalFn(poll)
    handlers.onClosed?.()
  }, POPUP_CLOSED_POLL_MS)

  return () => {
    target.removeEventListener('message', listener)
    unsubscribeChannel?.()
    ownChannel?.close()
    clearIntervalFn(poll)
  }
}

/** Whether `event` is the opener's ack: from `opener`, at `ownOrigin`. */
export function isOpenerAck(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  opener: Window | null,
  ownOrigin: string,
): boolean {
  if (opener === null || event.source !== opener || event.origin !== ownOrigin) return false
  const data = event.data as { type?: unknown } | null
  return typeof data === 'object' && data !== null && data.type === SSO_POPUP_ACK
}

/**
 * What the completion page shows when it neither closes nor moves on: a link
 * that failed, or a finished flow whose window the browser would not close.
 */
export type PopupResult = {
  readonly kind: 'link-error' | 'done'
  readonly message: string
}

export interface PopupCompletionEnv {
  readonly opener: Window | null
  readonly origin: string
  /** The same-origin "done" channel; `null` where `BroadcastChannel` is unavailable. */
  readonly channel: SsoChannel | null
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  close(): void
  /** Continue in this window — the full-page return. */
  continueAt(path: string): void
  /** Keep a login session at THIS origin, exactly as the login page would. */
  persistSession(token: string): Promise<void>
  /** Show an outcome on the completion page itself (it stays open). */
  showResult(result: PopupResult): void
  setTimeout(fn: () => void, ms: number): unknown
}

/** Resolve `true` when `listen` sees its signal within the ack timeout. */
function awaitAck(
  env: PopupCompletionEnv,
  listen: (done: () => void) => () => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const stop = listen(() => {
      if (settled) return
      settled = true
      stop()
      resolve(true)
    })
    env.setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      resolve(false)
    }, SSO_POPUP_ACK_TIMEOUT_MS)
  })
}

/** Hand the completion to a SAME-ORIGIN opener by `postMessage`; `true` once it acks. */
function handToOpener(
  completion: SsoPopupCompletion,
  opener: Window,
  env: PopupCompletionEnv,
): Promise<boolean> {
  const acked = awaitAck(env, (done) => {
    const listener = (event: MessageEvent): void => {
      if (isOpenerAck(event, opener, env.origin)) done()
    }
    env.addEventListener('message', listener)
    return () => env.removeEventListener('message', listener)
  })
  try {
    const message: PopupReturnMessage = { type: SSO_POPUP_MESSAGE, completion }
    opener.postMessage(message, env.origin)
  } catch {
    // Dropped: no ack will come, the timeout settles it.
  }
  return acked
}

/** Signal "done" on the channel (no token); `true` once a watcher acks. */
function signalOnChannel(
  signal: SsoDoneSignal,
  channel: SsoChannel,
  env: PopupCompletionEnv,
): Promise<boolean> {
  const acked = awaitAck(env, (done) =>
    channel.subscribe((data) => {
      if (isDoneAck(data)) done()
    }),
  )
  channel.post({ type: SSO_POPUP_DONE, ...signal })
  return acked
}

/**
 * The popup side (D791, amended): get the outcome to the window that opened
 * this popup, then close — over the first path that works:
 *
 *  1. `postMessage` to a SAME-ORIGIN opener (the completion, token included,
 *     to its own origin only) — closes on its ack.
 *  2. The same-origin channel, for an opener whose reference was severed: a
 *     login first keeps its session at this origin (as the full-page return
 *     would), then only "done" travels — never a token. Closes on an ack.
 *  3. An opener that is still there but unreachable — typically at ANOTHER
 *     origin, because the IdP returned to a different hub address than the
 *     one the flow started at: a successful link closes (the opener sees the
 *     popup close and refreshes); a failed one stays and says why.
 *  4. Nobody: the full-page return in this window, as before.
 */
export async function deliverPopupCompletion(
  completion: SsoPopupCompletion,
  env: PopupCompletionEnv,
): Promise<void> {
  const opener = env.opener !== null && !env.opener.closed ? env.opener : null
  if (opener !== null && readableOrigin(opener) === env.origin) {
    if (await handToOpener(completion, opener, env)) {
      env.close()
      return
    }
  }

  const token =
    completion.target === 'login' ? new URLSearchParams(completion.fragment).get('token') : null
  const hasSession = token !== null && token.length > 0
  const signal = doneSignalFor(completion, hasSession)
  if (signal !== null && env.channel !== null) {
    if (token !== null && hasSession) await env.persistSession(token)
    if (await signalOnChannel(signal, env.channel, env)) {
      env.close()
      return
    }
  }

  if (opener !== null && completion.target === 'profile') {
    const notice = externalLinkNotice(`?${completion.query}`)
    if (notice?.kind === 'error') {
      env.showResult({ kind: 'link-error', message: notice.message })
      return
    }
    env.close()
    return
  }
  env.continueAt(completionFallbackPath(completion))
}

/** Whether `pathname` (under the router `basename`) is the popup completion route. */
export function isSsoCompletePath(pathname: string, basename: string): boolean {
  const relative =
    basename.length > 0 && pathname.startsWith(basename)
      ? pathname.slice(basename.length)
      : pathname
  return relative.replace(/\/+$/, '') === SSO_POPUP_COMPLETE_ROUTE
}
