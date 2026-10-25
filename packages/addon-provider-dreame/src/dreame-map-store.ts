import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * A rendered map image (the vacuum's PNG raster or the mower's SVG) plus its
 * MIME type and the ms-epoch it was produced. The content type is stored so the
 * single data-plane route can serve either format with the correct header — a
 * browser `<img>` renders both `image/png` and `image/svg+xml`.
 */
export interface DreameMapImage {
  readonly bytes: Buffer
  readonly contentType: string
  readonly ts: number
}

/**
 * In-process store of the latest rendered map image, keyed by Dreame cloud
 * device id. The map child devices (`DreameVacuumMapDevice` /
 * `DreameMowerMapDevice`) write here on each new map frame; the addon's
 * data-plane handler ({@link serveMapImage}) reads from here to stream the bytes
 * to the browser.
 *
 * Module-level (like `dreameFacades`) because the kernel constructs device
 * classes with only a `DeviceContext` — it cannot thread the addon-scoped
 * data-plane handle into them, and the data-plane handler is registered once at
 * the addon level. The store is the seam between the two.
 */
const images = new Map<string, DreameMapImage>()

/**
 * The browser-facing base URL of the addon's `/map` data-plane route
 * (`/addon/<addonId>/map`), or `null` until the addon has registered it. NOT the
 * internal `127.0.0.1` listener URL — that one is hub-only.
 */
let baseUrl: string | null = null

export function setMapImage(dreameDeviceId: string, image: DreameMapImage): void {
  images.set(dreameDeviceId, image)
}

export function deleteMapImage(dreameDeviceId: string): void {
  images.delete(dreameDeviceId)
}

export function setMapBaseUrl(url: string | null): void {
  baseUrl = url
}

export function getMapBaseUrl(): string | null {
  return baseUrl
}

/**
 * Data-plane handler: stream the cached image for the `?did=<id>` query, or 404
 * when no map has been rendered for that device yet. Serves with the image's
 * stored content type (PNG for the vacuum, SVG for the mower). Registered on a
 * `public` route so a browser `<img>` can load it directly (the hub
 * reverse-proxy injects the per-listener secret).
 */
export function serveMapImage(req: IncomingMessage, res: ServerResponse): void {
  const did = new URL(req.url ?? '', 'http://addon.local').searchParams.get('did')
  const image = did !== null ? images.get(did) : undefined
  if (!image) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no map')
    return
  }
  res.writeHead(200, { 'content-type': image.contentType, 'cache-control': 'no-cache' })
  res.end(image.bytes)
}
