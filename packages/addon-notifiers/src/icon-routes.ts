/**
 * Serves the bundled per-kind brand icons (`icons-data.ts`) over the addon's
 * own HTTP surface via the `addon-routes` cap. One public GET route per kind:
 *
 *   GET /addon/notifiers/icons/<kind>  →  the bundled brand icon
 *
 * Each route sets the icon's OWN content-type (`image/svg+xml` for the vector
 * icons, `image/png` for the raster zentik logo) so a browser `<img src>`
 * renders it — an SVG that wraps a raster `data:` URI is blocked by the strict
 * `<img>` SVG mode, so zentik ships as its real PNG bytes instead.
 *
 * The bytes ship INSIDE the addon — no external CDN / hotlink — so the icons are
 * self-contained and CSP-safe. `listTargetKinds` stamps each kind with the
 * matching `iconUrl` (see `iconUrlFor`), letting the admin UI render
 * `<img src=iconUrl>` instead of a text label.
 *
 * We register a STATIC route per kind rather than one `/:kind` param route: the
 * forked-addon route bridge re-matches the pattern against itself, which would
 * clobber a `:kind` path param with the literal token `':kind'`. Static paths
 * carry no param, so they route correctly across the process boundary.
 *
 * ── Why the addon pre-encodes and owns `content-encoding` ────────────────────
 * The hub serves an addon route by piping the response THROUGH its global
 * `@fastify/compress`. For a forked addon, our reply body crosses the UDS route
 * bridge as opaque bytes and the hub then re-encodes them — and on that bridged
 * path the compressor emits an EMPTY brotli stream for any compressible body
 * over its 1 KiB threshold (`content-encoding: br` + `content-length: 0`), so a
 * browser `<img>` decodes nothing and shows a broken icon. Small icons (< 1 KiB)
 * and the raster PNG (a non-compressible type) slip under the compressor and
 * render, which is why only the larger SVGs broke.
 *
 * The fix is to make the compressor SKIP us: it leaves a response untouched when
 * `content-encoding` is already set to a non-identity coding. So each route
 * negotiates the request's `Accept-Encoding`, serves a pre-computed br/gzip/
 * deflate variant (or identity when the client accepts none), and stamps the
 * matching `content-encoding` itself. Bytes we own, correctly framed, reach the
 * browser intact. Mirrors the `compress: false` treatment the hub's own binary
 * pull route already uses for the same class of bug.
 */
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { type IAddonHttpRoute } from '@camstack/types'
import { type NotifierIcon, type NotifierIconKind, NOTIFIER_ICONS } from './icons-data.js'

/** The addon id — also the `/addon/<id>/…` route prefix. Mirrors `NOTIFIERS_ADDON_ID`. */
const NOTIFIERS_ROUTE_ID = 'notifiers'

/** One day; icons are immutable per addon version. */
const CACHE_CONTROL = 'public, max-age=86400, immutable'

const ICON_KINDS = new Set<string>(Object.keys(NOTIFIER_ICONS))

/** `true` when a bundled brand icon exists for `kind`. */
export function hasIcon(kind: string): boolean {
  return ICON_KINDS.has(kind)
}

/**
 * The stable per-kind icon URL, or `undefined` when no icon is bundled. Stamped
 * onto each descriptor by `listTargetKinds`. Root-relative so it resolves
 * against whatever origin the admin UI is served from.
 */
export function iconUrlFor(kind: string): string | undefined {
  return hasIcon(kind) ? `/addon/${NOTIFIERS_ROUTE_ID}/icons/${kind}` : undefined
}

/**
 * The media type `iconUrlFor(kind)` serves, or `undefined` when no icon is
 * bundled. The client needs it because SVG and raster render through different
 * components on React Native, and it cannot be guessed from the URL — the route
 * path deliberately carries no file extension.
 */
export function iconMediaTypeFor(kind: string): string | undefined {
  return hasIcon(kind) ? NOTIFIER_ICONS[kind as NotifierIconKind].contentType : undefined
}

/** The content codings we pre-compute, in the server's own preference order. */
type ContentCoding = 'br' | 'gzip' | 'deflate'

/** An icon's bytes pre-encoded in every coding we may serve, plus the identity
 *  bytes — all computed once at module load (the icons are immutable). */
interface EncodedIcon {
  readonly contentType: string
  readonly identity: Uint8Array
  readonly br: Uint8Array
  readonly gzip: Uint8Array
  readonly deflate: Uint8Array
}

/** Pre-encode one bundled icon into every content coding. */
function encodeIcon(icon: NotifierIcon): EncodedIcon {
  const identity =
    typeof icon.body === 'string' ? Buffer.from(icon.body, 'utf8') : Buffer.from(icon.body)
  return {
    contentType: icon.contentType,
    identity,
    br: brotliCompressSync(identity),
    gzip: gzipSync(identity),
    deflate: deflateSync(identity),
  }
}

/** Pick the best coding the client accepts (br › gzip › deflate), or `null` for
 *  identity when the header names none of them. Token-matched so `gzipx` or a
 *  `q=0` refusal don't false-positive. */
function negotiateEncoding(acceptEncoding: string): ContentCoding | null {
  const tokens = acceptEncoding
    .toLowerCase()
    .split(',')
    .map((part) => part.trim().split(';')[0]?.trim())
  for (const coding of ['br', 'gzip', 'deflate'] as const) {
    if (tokens.includes(coding)) return coding
  }
  return null
}

/** One static GET route serving the bundled icon for a single kind, with the
 *  icon's own content-type (svg vs png) and a client-negotiated content-coding
 *  the addon owns end-to-end (see the file header for why). */
function iconRoute(kind: NotifierIconKind): IAddonHttpRoute {
  const encoded = encodeIcon(NOTIFIER_ICONS[kind])
  return {
    method: 'GET',
    path: `/icons/${kind}`,
    access: 'public',
    description: `Official brand icon (${encoded.contentType}) for the '${kind}' notifier kind.`,
    handler: async (request, reply) => {
      const coding = negotiateEncoding(String(request.headers['accept-encoding'] ?? ''))
      reply
        .code(200)
        .type(encoded.contentType)
        .header('cache-control', CACHE_CONTROL)
        .header('vary', 'accept-encoding')
      if (coding !== null) reply.header('content-encoding', coding)
      reply.send(coding !== null ? encoded[coding] : encoded.identity)
    },
  }
}

/**
 * The icon routes, for composition into the addon's SINGLE `addon-routes`
 * provider. Not a provider of its own: a provider owns one route id and matches
 * paths within it, so the icons and the test samples must share one route set
 * (see `sample-routes.ts`).
 */
export function iconRoutes(): readonly IAddonHttpRoute[] {
  return (Object.keys(NOTIFIER_ICONS) as NotifierIconKind[]).map(iconRoute)
}
