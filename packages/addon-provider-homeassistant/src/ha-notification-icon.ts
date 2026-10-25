/**
 * Bundled brand icon for the `homeassistant` notification-output kind, served
 * by THIS addon over its own `addon-routes` HTTP surface. Mirrors the pattern
 * `addon-notifiers` uses for the other notifier kinds (each provider serves the
 * icon for the kinds it contributes), so `notificationOutput.listTargetKinds`
 * can stamp a self-hosted `iconUrl` onto the `homeassistant` descriptor and the
 * admin UI renders `<img src=iconUrl>` instead of a text label.
 *
 *   GET /addon/provider-homeassistant/icons/homeassistant  →  image/svg+xml
 *
 * The bytes ship INSIDE the addon (no external CDN / hotlink) so the icon is
 * self-contained and CSP-safe. The SVG is a standalone document (declares the
 * default `xmlns`, a `viewBox`, and an intrinsic `fill`) with NO editor-tool
 * namespaces, so a browser `<img src>` renders it in its strict SVG mode.
 *
 * We register ONE CONCRETE static route (`/icons/homeassistant`), never a
 * `/:kind` param route: the forked-addon route bridge re-matches the pattern
 * against itself and would clobber a `:kind` path param with the literal token
 * `':kind'`. A static path carries no param, so it routes correctly across the
 * process boundary.
 *
 * The route negotiates `Accept-Encoding` and stamps `content-encoding` itself
 * (serving a pre-computed br/gzip/deflate variant, or identity). This makes the
 * hub's global `@fastify/compress` skip the response — on the forked-addon route
 * bridge that compressor emits an EMPTY brotli stream for any compressible body
 * over its 1 KiB threshold, which shows as a broken `<img>`. Owning the coding
 * keeps this icon robust even if its bytes ever grow past the threshold, and
 * matches how `addon-notifiers` serves its notifier-kind icons.
 */
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import {
  buildAddonRouteProvider,
  type IAddonHttpRoute,
  type IAddonRouteProvider,
} from '@camstack/types'

/** The single notifier kind this addon contributes an icon for. */
const HA_ICON_KIND = 'homeassistant'

/** The addon id — also the `/addon/<id>/…` route prefix. Mirrors the manifest id. */
const HA_ROUTE_ID = 'provider-homeassistant'

/** One day; the icon is immutable per addon version. */
const CACHE_CONTROL = 'public, max-age=86400, immutable'

/**
 * Home Assistant's official brand mark (simple-icons `homeassistant`, CC0) —
 * the blue "house + circuit" glyph — tinted with the official HA brand hex
 * (#18BCF2) so it reads on the dark admin UI. A standalone SVG document, no
 * editor-tool namespaces.
 */
const HOME_ASSISTANT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="#18BCF2"><path d="M22.939 10.627 13.061.749a1.505 1.505 0 0 0-2.121 0l-9.879 9.878C.478 11.21 0 12.363 0 13.187v9c0 .826.675 1.5 1.5 1.5h9.227l-4.063-4.062a2.034 2.034 0 0 1-.664.113c-1.13 0-2.05-.92-2.05-2.05s.92-2.05 2.05-2.05 2.05.92 2.05 2.05c0 .233-.041.456-.113.665l3.163 3.163V9.928a2.05 2.05 0 0 1-1.15-1.84c0-1.13.92-2.05 2.05-2.05s2.05.92 2.05 2.05a2.05 2.05 0 0 1-1.15 1.84v8.127l3.146-3.146A2.051 2.051 0 0 1 18 12.239c1.13 0 2.05.92 2.05 2.05s-.92 2.05-2.05 2.05c-.25 0-.488-.047-.709-.13L12.9 20.602v3.088h9.6c.825 0 1.5-.675 1.5-1.5v-9c0-.825-.477-1.977-1.061-2.561z"/></svg>'

/**
 * The stable icon URL for the `homeassistant` kind. Stamped onto the descriptor
 * by `listTargetKinds`. Root-relative so it resolves against whatever origin
 * the admin UI is served from.
 */
export const HA_NOTIFICATION_ICON_URL = `/addon/${HA_ROUTE_ID}/icons/${HA_ICON_KIND}`

/**
 * Media type of {@link HA_NOTIFICATION_ICON_URL}, stamped onto the kind
 * descriptor beside the URL.
 *
 * Not decoration: a React-Native client renders SVG and raster through
 * DIFFERENT components (`react-native-svg` vs `expo-image`, and expo-image does
 * not decode SVG on iOS/Android), and it cannot infer the type from the URL
 * because the route path carries no file extension. Without this the viewer
 * treats the icon as raster and falls back to a placeholder glyph.
 */
export const HA_NOTIFICATION_ICON_MEDIA_TYPE = 'image/svg+xml'

/** The content codings we pre-compute, in the server's own preference order. */
type ContentCoding = 'br' | 'gzip' | 'deflate'

/** The icon's identity bytes plus every content coding we may serve, computed
 *  once at module load (the icon is immutable). */
const HA_ICON_IDENTITY: Uint8Array = Buffer.from(HOME_ASSISTANT_SVG, 'utf8')
const HA_ICON_ENCODED: Readonly<Record<ContentCoding, Uint8Array>> = {
  br: brotliCompressSync(HA_ICON_IDENTITY),
  gzip: gzipSync(HA_ICON_IDENTITY),
  deflate: deflateSync(HA_ICON_IDENTITY),
}

/** Pick the best coding the client accepts (br › gzip › deflate), or `null` for
 *  identity when the header names none of them. */
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

/** Build the `addon-routes` provider that serves the bundled Home Assistant icon. */
export function createHaIconRouteProvider(): IAddonRouteProvider {
  const route: IAddonHttpRoute = {
    method: 'GET',
    path: `/icons/${HA_ICON_KIND}`,
    access: 'public',
    description: "Official brand icon (SVG) for the 'homeassistant' notifier kind.",
    handler: async (request, reply) => {
      const coding = negotiateEncoding(String(request.headers['accept-encoding'] ?? ''))
      reply
        .code(200)
        .type('image/svg+xml')
        .header('cache-control', CACHE_CONTROL)
        .header('vary', 'accept-encoding')
      if (coding !== null) reply.header('content-encoding', coding)
      reply.send(coding !== null ? HA_ICON_ENCODED[coding] : HA_ICON_IDENTITY)
    },
  }
  return buildAddonRouteProvider(HA_ROUTE_ID, [route])
}
