import {
  errMsg,
  imageCapability,
  type DeviceContext,
  type ImageStatus,
  type InferNativeProvider,
} from '@camstack/types'
import {
  MowerDevice as DreameMower,
  MowerStatus,
  renderMowerSvg,
  type MowerMap,
} from '@apocaliss92/nodedreame'
import { DreameChildDevice } from './dreame-child-device.js'
import { deleteMapImage, getMapBaseUrl, setMapImage } from '../dreame-map-store.js'

const CAP_NAME = 'image'
const COLD: ImageStatus = { url: null, lastUpdated: null }

/**
 * Minimum spacing between live map re-fetches while the mower is actively
 * mowing. The saved-map geometry (zones / boundary) never changes; only the
 * mow-path trace grows during a session, so a coarse refresh keeps the rendered
 * trace fresh without hammering the cloud `getDeviceData` round-trip.
 */
const MOWER_MAP_REFRESH_MS = 30_000

/**
 * Dreame mower MAP child — a `DeviceType.Image` grouped UNDER the mower's
 * Container (mirrors {@link import('./dreame-vacuum-map-device.js').DreameVacuumMapDevice}).
 * Unlike the vacuum (whose map rides a PATH push of an OSS object name), the
 * mower's map is CLOUD-STORED batch data (`iotuserdata/getDeviceData`) that is
 * readable even while the mower is docked/asleep — so it is fetched on activate
 * and re-fetched on a coarse interval only while mowing (to advance the trace).
 *
 * `renderMowerSvg` produces an SVG (not a raster); it is served verbatim through
 * the addon's `/map` data-plane route with an `image/svg+xml` content type, which
 * a browser `<img>` renders directly.
 */
export class DreameMowerMapDevice extends DreameChildDevice {
  /** Single-flight guard for the async batch-fetch + render. */
  #inflight = false
  /** ms-epoch of the last successful render — gates the mowing-time refresh. */
  #lastRenderTs = 0

  // Widens the base's `protected` constructor to public so `dreameMowerMapChildFactory`
  // can `new` it. The forward is required for the visibility change.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The saved map is cloud-stored — fetch it once on activate so the image is
    // populated immediately, without waiting for a mow session. Best-effort: a
    // model with no saved map (or a transient cloud error) just stays null.
    const mower = this.resolveMower()
    if (mower !== null) void this.#refreshMap(mower)
  }

  /** Narrow the generic handle to the library's typed {@link DreameMower}, or null. */
  private resolveMower(): DreameMower | null {
    const handle = this.resolveHandle()
    return handle instanceof DreameMower ? handle : null
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof imageCapability> = {
      getStatus: async () => this.runtimeState.getCapState<ImageStatus>(CAP_NAME) ?? COLD,
    }
    this.ctx.registerNativeCap(imageCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, COLD)
  }

  protected override recomputeSlice(): void {
    const mower = this.resolveMower()
    if (mower === null) return
    // Re-fetch only while actively mowing, and no more than once per refresh
    // window — the static geometry is unchanged; this advances the mow-path
    // trace. Docked/idle keeps the map last rendered on activate.
    if (mower.status !== MowerStatus.Mowing) return
    if (Date.now() - this.#lastRenderTs < MOWER_MAP_REFRESH_MS) return
    void this.#refreshMap(mower)
  }

  /** Single-flight: fetch the batch map, render it to SVG, publish bytes + url. */
  async #refreshMap(mower: DreameMower): Promise<void> {
    if (this.#inflight) return
    this.#inflight = true
    try {
      const map = await mower.getMap()
      this.#publishRender(map)
    } catch (err) {
      this.ctx.logger.debug('dreame mower map: fetch/render failed', {
        tags: { deviceId: this.id },
        meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
      })
    } finally {
      this.#inflight = false
    }
  }

  /** Render the map to SVG + publish the bytes and the cache-busting `url`. */
  #publishRender(map: MowerMap): void {
    const svg = Buffer.from(renderMowerSvg(map, {}), 'utf8')
    const ts = Date.now()
    setMapImage(this.dreameDeviceId, { bytes: svg, contentType: 'image/svg+xml', ts })
    this.#lastRenderTs = ts
    const base = getMapBaseUrl()
    const url =
      base !== null ? `${base}?did=${encodeURIComponent(this.dreameDeviceId)}&t=${ts}` : null
    this.runtimeState.setCapState(CAP_NAME, { url, lastUpdated: ts })
  }

  override async removeDevice(): Promise<void> {
    await super.removeDevice()
    deleteMapImage(this.dreameDeviceId)
  }
}
