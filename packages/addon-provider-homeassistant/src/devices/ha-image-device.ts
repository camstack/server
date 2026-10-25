import {
  imageCapability,
  errMsg,
  type DeviceContext,
  type InferNativeProvider,
  type ImageStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: ImageStatus = {
  url: null,
  lastUpdated: null,
}

/**
 * HA-backed image device — `image.*`. Read-only: no service methods,
 * the provider only exposes `getStatus`.
 *
 * HA `image.*` entities expose `attributes.entity_picture` — a RELATIVE
 * path carrying a signed `?token=` access token (e.g.
 * `/api/image_proxy/image.foo?token=…`). The image changes when the
 * entity state (a timestamp) changes.
 *
 * We resolve the HA base URL from the broker config once (lazily,
 * cached) and join the relative path against it with `new URL(...)`,
 * preserving the token in the query string so the browser can load the
 * image directly with NO auth header.
 *
 * `baseUrl` is connection config (not cap state) so it lives in a
 * private field rather than the runtime-state slice. The async resolve +
 * slice-write happens in a fire-and-forget helper because
 * `handleStatePush` is sync; resolution failures are logged and leave
 * the url null — never thrown out of the push handler.
 */
export class HaImageDevice extends HaBaseChildDevice {
  /** Lazily-resolved HA base URL (connection config, NOT cap state). */
  private baseUrl: string | null = null
  /** Single-flight guard for the lazy base-url resolve. */
  private baseUrlResolving: Promise<string | null> | null = null
  /**
   * Recency guard. The sync null-write path and the async resolve path can
   * interleave; we stamp the newest push's `lastUpdated` here so a slower
   * async resolve for an OLDER push can bail before clobbering a newer write.
   */
  private latestLastUpdated = 0

  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerImageCap()
    this.runtimeState.setCapState('image', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const entityPicture = readStringAttr(state.attributes, 'entity_picture')
    const lastUpdated = Date.parse(state.last_updated) || Date.now()
    // Stamp recency BEFORE branching so a later async resolve for an older
    // push can detect it lost the race.
    this.latestLastUpdated = Math.max(this.latestLastUpdated, lastUpdated)
    if (entityPicture === null) {
      this.runtimeState.setCapState('image', { url: null, lastUpdated })
      return
    }
    // Async base-url resolve + absolute-url build. Fire-and-forget: the
    // push handler is sync. Errors are handled inside resolveAndSet, so
    // this never produces an unhandled rejection.
    void this.resolveAndSet(entityPicture, lastUpdated)
  }

  /**
   * Resolve the base URL (lazily), join the relative `entity_picture`
   * into an absolute URL, and write the slice. Never throws — a resolve
   * or join failure logs a warning and writes a null-url slice.
   */
  private async resolveAndSet(entityPicture: string, lastUpdated: number): Promise<void> {
    let url: string | null = null
    try {
      const base = await this.resolveBaseUrl()
      if (base !== null) {
        url = new URL(entityPicture, base).toString()
      } else {
        this.deviceLogger.warn('ha-image: no base URL resolved — leaving image url null', {
          meta: { entityId: this.entityId, brokerId: this.brokerId },
        })
      }
    } catch (err) {
      this.deviceLogger.warn('ha-image: failed to build absolute image url', {
        meta: { entityId: this.entityId, brokerId: this.brokerId, error: errMsg(err) },
      })
      url = null
    }
    // Recency guard: a newer push already wrote a slice while we were
    // resolving — bail rather than clobber it with a stale image.
    if (lastUpdated < this.latestLastUpdated) return
    this.runtimeState.setCapState('image', { url, lastUpdated })
  }

  /**
   * Resolve the HA base URL from the broker config, once. The config is
   * a settings record; `baseUrl` is present for long-lived-token brokers
   * and absent for supervisor-token brokers (where the relative path is
   * served by the supervisor proxy and a base URL isn't exposed here).
   */
  private async resolveBaseUrl(): Promise<string | null> {
    if (this.baseUrl !== null) return this.baseUrl
    if (this.baseUrlResolving !== null) return this.baseUrlResolving
    this.baseUrlResolving = this.fetchBaseUrl()
    try {
      this.baseUrl = await this.baseUrlResolving
      return this.baseUrl
    } finally {
      this.baseUrlResolving = null
    }
  }

  private async fetchBaseUrl(): Promise<string | null> {
    const cfg = await this.ctx.api.broker.getBrokerConfig.query({ id: this.brokerId })
    const raw = cfg?.['baseUrl']
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  }

  private registerImageCap(): void {
    const provider: InferNativeProvider<typeof imageCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<ImageStatus>('image') ?? COLD_START
      },
    }
    this.ctx.registerNativeCap(imageCapability, provider)
  }
}

function readStringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}
