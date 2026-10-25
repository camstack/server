/**
 * Where the runner gets the ONE detail-crop convention.
 *
 * ## Why the runner, and only the runner
 *
 * Every detail crop is now cut inside `runDetailSubtree` — the live plane from
 * a frame handle, the embedding rebuild from a stored key frame it ships in as
 * `frameJpeg`. One cutter means one reader: nothing else needs the value, so
 * nothing else can drift from it.
 *
 * ## Why a settings read and not the attach config
 *
 * `RunnerCameraConfig` is the obvious orchestrator→runner channel, and it is
 * the wrong one here. Eleven separate call sites construct a
 * `RunnerCameraConfig` (session dispatch, standing dispatch, zone refresh,
 * node reconnect, placement correction, …). A cluster-wide constant threaded
 * through eleven builders is a constant that eventually reaches ten of them,
 * and the failure is invisible: the cameras attached by the forgotten builder
 * quietly cut a different crop and write it into the same index. That is the
 * bug this whole change exists to remove, so it must not be reintroduced as
 * the delivery mechanism.
 *
 * Instead the runner reads the OWNER addon's global settings directly, the way
 * both decoder addons read their backend selector
 * (`decoder-backend.ts`) — hub-routed by `AddonCallGateway`, so an agent runner
 * transparently reads the hub-central store with no placement branching.
 *
 * ## Deliberately NOT node-scoped
 *
 * The read passes no `nodeId`. With one, `addon-settings` would project that
 * node's scoped value and two nodes could cut different crops into the same
 * `object-clip` index — the original defect, relocated to the transport.
 */
import {
  DEFAULT_DETAIL_CROP_CONVENTION,
  type DetailCropConvention,
  type HydratedSettingsView,
  type IScopedLogger,
  pickDetailCropConvention,
} from '@camstack/types'

/**
 * The addon whose GLOBAL settings own the convention. `pipeline-orchestrator`
 * is hub-resident and neutral — it already owns the per-node decoder-backend
 * selector for the same reason (neither consumer should own a value the other
 * depends on).
 */
export const CROP_CONVENTION_OWNER_ADDON_ID = 'pipeline-orchestrator'

/** How long a read is trusted. A detail dispatch is per-track, not per-frame. */
export const CROP_CONVENTION_TTL_MS = 60_000

/** The hub-routed global-settings read, structurally typed so tests can fake it. */
export interface CropConventionSettingsApi {
  readonly addonSettings: {
    readonly getGlobalSettings: {
      query(input: { addonId: string }): Promise<HydratedSettingsView | null>
    }
  }
}

export interface CropConventionSourceOptions {
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  /** Injected clock — the TTL is otherwise untestable without sleeping. */
  readonly now?: () => number
  readonly ttlMs?: number
}

/**
 * TTL-cached read of the cluster crop convention.
 *
 * {@link current} is synchronous because the crop derivation is, and because a
 * value that is never missing is easier to reason about than one that is
 * sometimes a promise. {@link refresh} is what actually talks to the hub;
 * the runner awaits it at the top of a detail dispatch.
 */
export class CropConventionSource {
  private convention: DetailCropConvention = DEFAULT_DETAIL_CROP_CONVENTION
  private lastReadAtMs = Number.NEGATIVE_INFINITY
  private inFlight: Promise<void> | null = null
  private readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(options: CropConventionSourceOptions) {
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? CROP_CONVENTION_TTL_MS
  }

  /** The convention in force right now — the default until a read lands. */
  current(): DetailCropConvention {
    return this.convention
  }

  /**
   * Re-read if the cached value has expired. Concurrent callers share one
   * in-flight read; a failure keeps the LAST KNOWN value rather than reverting
   * to the default, because a mid-pass revert would silently change what every
   * remaining vector of that pass means.
   */
  async refresh(api: CropConventionSettingsApi | undefined): Promise<DetailCropConvention> {
    if (api === undefined) return this.convention
    if (this.now() - this.lastReadAtMs < this.ttlMs) return this.convention
    this.inFlight ??= this.read(api).finally(() => {
      this.inFlight = null
    })
    await this.inFlight
    return this.convention
  }

  private async read(api: CropConventionSettingsApi): Promise<void> {
    try {
      const view = await api.addonSettings.getGlobalSettings.query({
        addonId: CROP_CONVENTION_OWNER_ADDON_ID,
      })
      const next = pickDetailCropConvention(view)
      this.lastReadAtMs = this.now()
      if (
        next.paddingRatio !== this.convention.paddingRatio ||
        next.square !== this.convention.square
      ) {
        // The one line that explains a step-change in search quality. Without
        // it, "the index went bad on Tuesday" has no anchor.
        this.logger.info('detail crop convention changed — stored vectors need a rebuild', {
          meta: { from: { ...this.convention }, to: { ...next } },
        })
        this.convention = next
      }
    } catch (err: unknown) {
      // Not fatal, but never silent: an unreadable convention means the runner
      // is cutting to a value the operator may not have chosen.
      this.logger.warn('detail crop convention read failed — keeping the last known value', {
        meta: {
          owner: CROP_CONVENTION_OWNER_ADDON_ID,
          inUse: { ...this.convention },
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }
}
