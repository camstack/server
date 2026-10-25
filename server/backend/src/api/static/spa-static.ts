/**
 * spa-static — shared static-serving helpers for the SPAs the hub mounts
 * (admin-ui at `/`, viewer-ui at `/viewer/camstack`). Extracted so both
 * mount points apply IDENTICAL cache policy: content-hashed build assets are
 * immutable; the service worker / registration / web manifest + the SPA shell
 * (`index.html`) always revalidate so a redeploy actually reaches clients.
 */

/**
 * Cache-Control for the SPA SHELL (`index.html`) — the HTML entry only, never a
 * hashed asset.
 *
 * The shell is the one file that must never survive a deploy: it carries the
 * `<script src="assets/index-<hash>.js">` pointers, so a stale copy loads a
 * build whose hashed assets no longer exist — the operator sees the previous UI
 * or a blank page and has to force-refresh. It is a few KB, and every in-app
 * navigation is client-side, so re-fetching it costs nothing measurable.
 *
 * `no-store`, not `no-cache`: the shell is streamed with no ETag and no
 * Last-Modified, so a revalidation could never answer 304 anyway — and
 * `no-store` additionally keeps the response out of the heuristic and
 * back/forward caches that made this visible. The addon-route fallback used to
 * send the shell with NO header at all, which is where the stale copies came
 * from.
 */
export function spaShellCacheControl(): string {
  return 'no-store'
}

/**
 * Cache-Control value for a static SPA asset addressed by its dist-relative
 * path. Policy (shared by admin-ui + viewer-ui):
 *   - `sw.js` / `registerSW.js` / `workbox-*.js` / `manifest.webmanifest`
 *     → `no-cache, must-revalidate` (PWA update propagation).
 *   - Content-hashed build assets under `assets/` (Vite) or `_expo/` (Expo
 *     web export) → `public, max-age=31536000, immutable`.
 *   - The shell requested BY NAME (`/index.html`) reaches this function rather
 *     than the shell branch of the handler — it gets {@link spaShellCacheControl}
 *     so the same bytes never carry two different policies.
 *   - Everything else (favicon, non-hashed files) → `no-cache`.
 */
export function spaAssetCacheControl(rel: string): string {
  const base = rel.split('/').pop() ?? rel
  if (/^(sw\.js|registerSW\.js|workbox-.*\.js|manifest\.webmanifest)$/.test(base)) {
    return 'no-cache, must-revalidate'
  }
  const inAssetDir =
    rel.startsWith('assets/') ||
    rel.startsWith('_expo/') ||
    rel.includes('/assets/') ||
    rel.includes('/_expo/')
  if (inAssetDir && /-[A-Za-z0-9_-]{8,}\./.test(base)) {
    return 'public, max-age=31536000, immutable'
  }
  if (base === 'index.html') return spaShellCacheControl()
  return 'no-cache'
}

/**
 * Cache-Control for an addon MF bundle file (`/api/addon-widgets/…`).
 *
 * Immutable is granted ONLY to filenames carrying a Vite/rolldown content
 * hash (`<name>-<hash8>.mjs`) — never by exclusion. The previous policy
 * ("everything that isn't the entry is hashed") aged out the moment the
 * rolldown MF plugin emitted `_stub.js`: a FIXED filename with MUTABLE
 * content (the real exposes module). Browsers kept the year-long
 * immutable copy across addon updates, its imports pointed at hashed
 * sibling chunks that no longer existed, and the widget failed to load
 * until a manual hard-reload. Unknown fixed names now revalidate — the
 * cost is a cheap 304.
 */
export function addonBundleCacheControl(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath
  // Vite/rolldown content hash: exactly 8 base64url chars between a
  // hyphen and the extension (`dist-CYZr2fwk.mjs`, `….js-CQ-aEQ9b.mjs`).
  if (/-[A-Za-z0-9_-]{8}\.(mjs|js|css)$/.test(base)) {
    return 'public, max-age=31536000, immutable'
  }
  return 'no-cache, must-revalidate'
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

/**
 * Best-effort MIME type for a static file path. Used when streaming viewer
 * assets directly (the admin-ui path goes through @fastify/static). Defaults
 * to `application/octet-stream` for unknown extensions.
 */
export function contentTypeForPath(pathname: string): string {
  const base = pathname.split('/').pop() ?? pathname
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/** Paths intentionally retired instead of falling through to the admin SPA. */
export function isRetiredPublicPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? url
  return (
    pathname === '/addon/stream-broker/embed' || pathname.startsWith('/addon/stream-broker/embed/')
  )
}
