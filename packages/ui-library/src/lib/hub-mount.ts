/**
 * Where the hub is, from inside a page the hub served.
 *
 * The admin UI is not always at the hub's root. The Home Assistant component
 * frames it through a same-origin relay — `https://<ha>/api/camstack/p/<grant>/…`
 * → `https://<hub>:4443/…` — so the browser never has to trust the hub's
 * local certificate. The relay sends `X-Forwarded-Prefix` and the hub
 * injects two things into the shell it serves for that request:
 *
 *   <base href="<prefix>/">
 *   <meta name="camstack-mount" content="<prefix>/">
 *
 * This module is the ONE reader of that fact. Every URL the page composes
 * toward the hub — tRPC HTTP and WS, `/api/webrtc`, `/addon/…` data planes,
 * `/api/addon-assets`, MF remote entries, `<img src>` — goes through it:
 *
 *   - `hubPath('/api/x')`  → `/api/x` at the root, `/<prefix>/api/x` under one.
 *     A same-origin path; the default for fetch, `<img>`, links.
 *   - `hubOrigin()`        → `https://host` or `https://host/<prefix>`; the
 *     `serverUrl` handed to the SDK and the players (they append `/trpc`,
 *     `/api/webrtc`, `/adaptive-probe` themselves).
 *   - `hubUrl()` / `hubWsUrl()` — absolute http(s) / ws(s) forms.
 *   - `routerBasename()`   → `''` or `/<prefix>`, for `<BrowserRouter>`.
 *
 * Why not `window.location.origin` + a literal: `<base>` does not apply to a
 * root-absolute path, so `'/api/x'` leaves the relay and lands on HA's own
 * `/api/x`. And why not `document.baseURI` alone: without a `<base>` it is
 * the DOCUMENT's URL, so `/devices/5` would read as a mount of `/devices/`.
 * The meta is the authority; a `<base>` element is accepted on its own for a
 * host that injects only that.
 *
 * `scripts/check-hub-paths-through-mount.ts` keeps every other module from
 * spelling a hub path directly.
 */

const MOUNT_META_NAME = 'camstack-mount'

/** A clean absolute path: no scheme, no `//`, no `..`, no query. */
const MOUNT_PATH_RE = /^\/(?:[A-Za-z0-9_\-.]+\/)*$/

let resolvedMount: string | null = null

function normaliseMount(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  const withSlash = raw.endsWith('/') ? raw : `${raw}/`
  if (!MOUNT_PATH_RE.test(withSlash)) return null
  if (withSlash.includes('/../') || withSlash.includes('/./')) return null
  return withSlash
}

function readMountFromDocument(): string {
  if (typeof document === 'undefined') return '/'
  const meta = document.querySelector(`meta[name="${MOUNT_META_NAME}"]`)
  const fromMeta = normaliseMount(meta?.getAttribute('content'))
  if (fromMeta !== null) return fromMeta
  const base = document.querySelector('base[href]')
  if (base !== null) {
    try {
      const url = new URL(document.baseURI)
      if (url.origin === window.location.origin) {
        const fromBase = normaliseMount(url.pathname)
        if (fromBase !== null) return fromBase
      }
    } catch {
      // An unparsable base URI is no mount at all.
    }
  }
  return '/'
}

/**
 * The path the app is mounted at, with a trailing slash: `/` or `/<prefix>/`.
 * Resolved once — the shell is the only thing that can say where it lives,
 * and it says so before any script runs.
 */
export function mountPath(): string {
  if (resolvedMount === null) resolvedMount = readMountFromDocument()
  return resolvedMount
}

/** `<BrowserRouter basename>`: the mount without its trailing slash. */
export function routerBasename(): string {
  return mountPath().replace(/\/$/, '')
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')
}

/**
 * A same-origin path under the mount. Absolute URLs and paths already under
 * the mount pass through unchanged, so a server-stamped `bundleUrl` can be
 * wrapped without knowing whether it was.
 */
export function hubPath(pathname: string): string {
  if (isAbsoluteUrl(pathname)) return pathname
  const mount = mountPath()
  const relative = pathname.replace(/^\/+/, '')
  if (mount !== '/' && (pathname === routerBasename() || pathname.startsWith(mount))) {
    return pathname
  }
  return `${mount}${relative}`
}

/** The absolute hub base with no trailing slash — the SDK's `serverUrl`. */
export function hubOrigin(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}${routerBasename()}`
}

/** An absolute http(s) URL for a hub path. */
export function hubUrl(pathname: string): string {
  if (isAbsoluteUrl(pathname)) return pathname
  return `${hubOrigin()}${hubPath(pathname).slice(routerBasename().length)}`
}

/** The ws(s) twin of {@link hubUrl}. */
export function hubWsUrl(pathname: string): string {
  return hubUrl(pathname).replace(/^http/, 'ws')
}

/** Tests mutate `<head>` between cases; production resolves once. */
export function resetHubMountForTests(): void {
  resolvedMount = null
}
