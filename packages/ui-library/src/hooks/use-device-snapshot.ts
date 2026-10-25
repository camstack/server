/**
 * useDeviceSnapshotImage — a device's snapshot as a plain image URL.
 *
 * ## What this used to do, and why it stopped
 *
 * It fetched `dev.snapshot.getSnapshot()` over tRPC and returned
 * `data:image/jpeg;base64,…`. That put a full camera capture — up to 4 K,
 * measured at 758 KB average per camera on the live hub — through the msgpack
 * WebSocket plane, base64-inflated by a third, and then held it in the
 * react-query heap for 24 h per device. The device list rendered it into a
 * **28 × 28 px `<img>`**.
 *
 * It also did not do what it appeared to do. `snapshot.getSnapshot` scoped to a
 * device routes to the NATIVE provider, not the snapshot wrapper, so it bypassed
 * the wrapper's cache, coalescing and stale-while-revalidate entirely: probed
 * live, a `force:true` call returned a fresh 1.05 MB JPEG in 0.55 s while the
 * wrapper's `lastCapturedAt` for that camera did not move. Two snapshot paths,
 * different behaviour, and only one of them maintained the cache the other one
 * reported on.
 *
 * ## What it does now
 *
 * Returns the same URL the viewer uses: `/addon/snapshot/media/<id>.jpg?w=<n>`,
 * served by the wrapper over the HTTP data plane. Relative and same-origin, so
 * the admin UI's `camstack_session` cookie authenticates it — the endpoint is
 * `access: 'authenticated'`, which accepts either a Bearer header or that
 * cookie, and a bare `<img>` can only send the cookie. This is the same
 * mechanism the native `<video>` fallback in `hls-video.tsx` already relies on.
 *
 * Caching is now the browser's, which is the point: `ETag` +
 * `Cache-Control: private, max-age=<device maxAgeS>` means a repeat render is a
 * cache hit and a revalidation is a 0-byte 304. No JS heap, no msgpack, no
 * base64. Nothing to configure — unlike `expo-image` on native, browsers
 * revalidate a stale URL rather than treating it as immutable, so the URL stays
 * stable and does NOT need a version parameter.
 */
import { useCallback, useMemo, useState } from 'react'
import { routerBasename } from '../lib/hub-mount'

/** The hub-proxied path prefix for the snapshot image data plane, composed
 *  below on `baseUrl` or, for the same-origin case, on the page's mount. */
export const SNAPSHOT_MEDIA_PATH = '/addon/snapshot/media' // hub-path-ok: composed on baseUrl ?? routerBasename()

export interface DeviceSnapshotImage {
  /** Image URL ready for `<img src>`, or `null` when there is no device. */
  readonly src: string | null
  /**
   * Always false. Kept so existing callers' spinners compile; a URL needs no
   * fetch state, and the `<img>` element owns its own load lifecycle (an
   * unavailable snapshot surfaces as `onError`, which every consumer already
   * handles because a device can legitimately have no camera).
   */
  readonly loading: boolean
  /** Force ONE fresh capture (bypasses the wrapper's freshness gate, and wakes
   *  a battery camera — an operator action only). */
  readonly refresh: () => void
}

export interface UseDeviceSnapshotOptions {
  /**
   * Target width in px. The server snaps it to a ladder
   * ([160, 240, 320, 480, 640, 960]) and derives the variant once per capture,
   * so nearby sizes share one image. **Omitting it returns the frame as
   * captured** — which is how a 28 px thumbnail came to cost a megabyte.
   */
  readonly width?: number
  /** Absolute hub base. Omit in the admin UI, which is same-origin with the
   *  hub — the path then follows the page's mount (`hub-mount.ts`). */
  readonly baseUrl?: string
}

export function useDeviceSnapshotImage(
  deviceId: number | null,
  options: UseDeviceSnapshotOptions = {},
): DeviceSnapshotImage {
  const { width, baseUrl } = options
  // Bumped by `refresh()`. It rides the URL so the browser cannot answer an
  // explicit operator refresh out of its own cache.
  const [refreshNonce, setRefreshNonce] = useState(0)

  const src = useMemo(() => {
    if (deviceId === null || deviceId <= 0) return null
    const base = baseUrl !== undefined ? baseUrl.replace(/\/+$/, '') : routerBasename()
    const params = new URLSearchParams()
    if (width !== undefined && Number.isInteger(width) && width > 0) {
      params.set('w', String(width))
    }
    if (refreshNonce > 0) {
      params.set('force', '1')
      params.set('r', String(refreshNonce))
    }
    const query = params.toString()
    return `${base}${SNAPSHOT_MEDIA_PATH}/${String(deviceId)}.jpg${query.length > 0 ? `?${query}` : ''}`
  }, [deviceId, width, baseUrl, refreshNonce])

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [])

  return { src, loading: false, refresh }
}
