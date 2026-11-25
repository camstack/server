/**
 * app-shell-bridge — the admin UI's end of the `app-bridge` envelope (D1096).
 *
 * The admin UI is chromeless only once the shell has said `hello`. Everything the
 * shell sends is accepted only from the shell itself:
 *  - in a same-origin frame, from `window.parent` and from this page's own
 *    origin (the hub refuses every other ancestor, `frame-ancestors 'self'`);
 *  - in the viewer's native WebView, from the shell's script injection, which
 *    carries no source and no origin (a frame cannot produce that).
 * Anything else, and anything that is not a shell-to-app message, is ignored.
 * The app posts back only to its own origin, never `*`.
 */
import {
  ShellToAppMessageSchema,
  type AppToShellMessage,
  type ShellToAppMessage,
} from '@camstack/types'

/** The `ReactNativeWebView` channel the viewer's native WebView puts on the page. */
interface NativeBridge {
  postMessage(data: string): void
}

/** What a received `message` event carries that the origin rules look at. */
export interface ShellEventLike {
  readonly data: unknown
  readonly origin: string
  readonly source: unknown
}

/** Where this page stands relative to the shell, read once from the window. */
export interface ShellEndpoint {
  /** The shell's window when framed on the web; `null` otherwise. */
  readonly parent: unknown
  /** This page's own origin: the only origin a framing shell may have. */
  readonly origin: string
  /** True inside the viewer's native WebView. */
  readonly native: boolean
}

function isNativeBridge(value: unknown): value is NativeBridge {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'postMessage') === 'function'
  )
}

function nativeBridgeOf(win: Window): NativeBridge | null {
  const candidate: unknown = Reflect.get(win, 'ReactNativeWebView')
  return isNativeBridge(candidate) ? candidate : null
}

export function shellEndpointOf(win: Window = window): ShellEndpoint {
  const framed = win.parent !== win
  return {
    parent: framed ? win.parent : null,
    origin: win.location.origin,
    native: nativeBridgeOf(win) !== null,
  }
}

function decode(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * A router path the shell may send: one leading `/`. `//host` (protocol-relative),
 * `/\\host` and anything else is refused, so a navigate can never leave the app.
 */
export function isShellPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
}

/** The shell message this event is, or `null` when it is not one from the shell. */
export function acceptShellMessage(
  event: ShellEventLike,
  endpoint: ShellEndpoint,
): ShellToAppMessage | null {
  const fromFrameParent =
    endpoint.parent !== null && event.source === endpoint.parent && event.origin === endpoint.origin
  const fromNativeInjection = endpoint.native && event.source === null && event.origin === ''
  if (!fromFrameParent && !fromNativeInjection) return null
  const parsed = ShellToAppMessageSchema.safeParse(decode(event.data))
  if (!parsed.success) return null
  if (parsed.data.type === 'navigate' && !isShellPath(parsed.data.path)) return null
  return parsed.data
}

/** Send to the shell, or `null` when this page has no shell to talk to. */
export function shellSenderOf(win: Window = window): ((message: AppToShellMessage) => void) | null {
  const native = nativeBridgeOf(win)
  if (native !== null) return (message) => native.postMessage(JSON.stringify(message))
  if (win.parent === win) return null
  const parent = win.parent
  const origin = win.location.origin
  return (message) => parent.postMessage(message, origin)
}

/** The router-relative path the shell is told, query included. */
export function shellPathOf(location: {
  readonly pathname: string
  readonly search: string
}): string {
  return `${location.pathname}${location.search}`
}
