/**
 * Where the runner gets the cluster-wide native-frame LEASE knobs.
 *
 * ## Why a settings read and not the attach config
 *
 * Identical reasoning to `crop-convention-source.ts`, and worth restating
 * because the temptation is the same: `RunnerCameraConfig` is the obvious
 * orchestrator→runner channel and it is the wrong one. Eleven call sites build
 * one; a cluster-wide constant threaded through eleven builders eventually
 * reaches ten of them, and the cameras attached by the forgotten builder just
 * quietly run a different lease window. Instead the runner reads the OWNER
 * addon's global settings directly, hub-routed by `AddonCallGateway`, so an
 * agent runner transparently reads the hub-central store with no placement
 * branching.
 *
 * ## Deliberately NOT node-scoped
 *
 * The read passes no `nodeId`. With one, `addon-settings` would project that
 * node's scoped value and two nodes could hold different lease windows for the
 * same camera — so whether a stored crop is native pixels or the ≤106 fallback
 * would depend on where the balancer happened to place it, which is invisible
 * from the stored media.
 *
 * ## What it hands out
 *
 * A {@link NativeLeaseSettingsOverride} — only the knobs the operator SET. The
 * decode worker resolves the rest (env var, then the shipped default); see
 * `session-decode/native-lease-config.ts` for the precedence. Handing out a
 * fully-resolved triple here would erase the "operator set nothing" state and
 * with it the env-var escape hatch.
 */
import {
  type HydratedSettingsView,
  type IScopedLogger,
  type NativeLeaseSettingsOverride,
  pickNativeLeaseOverride,
} from '@camstack/types'

/**
 * The addon whose GLOBAL settings own the knobs. `pipeline-orchestrator` is
 * hub-resident and neutral — the same owner as the detail-crop convention and
 * the per-node decoder-backend selector.
 */
export const NATIVE_LEASE_OWNER_ADDON_ID = 'pipeline-orchestrator'

/**
 * How long a read is trusted. Shorter than the crop convention's 60 s because
 * this value is verified by CHANGING it and watching the next worker's log
 * line: a two-minute wait to see whether a setting took makes the knob feel
 * broken. A decode-worker fork is per-session, not per-frame, so the read is
 * cheap at this rate.
 */
export const NATIVE_LEASE_TTL_MS = 30_000

/** The hub-routed global-settings read, structurally typed so tests can fake it. */
export interface NativeLeaseSettingsApi {
  readonly addonSettings: {
    readonly getGlobalSettings: {
      query(input: { addonId: string }): Promise<HydratedSettingsView | null>
    }
  }
}

export interface NativeLeaseSettingsSourceOptions {
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  /** Injected clock — the TTL is otherwise untestable without sleeping. */
  readonly now?: () => number
  readonly ttlMs?: number
}

/**
 * Whether two overrides name the same knobs with the same values.
 *
 * **Every knob has to appear here.** This is the equality that decides whether
 * a re-read is ADOPTED at all: a knob missing from the comparison is read from
 * the hub, judged identical, and discarded, so the operator's change never
 * reaches a decode worker and nothing anywhere says so. `admission` shipped
 * missing from this list and did exactly that — the setting was stored, the
 * hub served it, the runner fetched it, and every worker kept spawning with the
 * old value.
 */
function sameOverride(a: NativeLeaseSettingsOverride, b: NativeLeaseSettingsOverride): boolean {
  return (
    a.holdFrames === b.holdFrames &&
    a.budgetMb === b.budgetMb &&
    a.activityMs === b.activityMs &&
    a.admission === b.admission &&
    a.tileBudgetMb === b.tileBudgetMb
  )
}

/**
 * TTL-cached read of the cluster native-lease knobs.
 *
 * {@link current} is synchronous because the fork that consumes it is;
 * {@link refresh} is what talks to the hub, and the runner awaits it on the
 * path that precedes a decode-worker spawn.
 */
export class NativeLeaseSettingsSource {
  private override: NativeLeaseSettingsOverride = {}
  private lastReadAtMs = Number.NEGATIVE_INFINITY
  private inFlight: Promise<void> | null = null
  private readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(options: NativeLeaseSettingsSourceOptions) {
    this.logger = options.logger
    this.now = options.now ?? ((): number => Date.now())
    this.ttlMs = options.ttlMs ?? NATIVE_LEASE_TTL_MS
  }

  /** The operator's overrides as last read — `{}` until a read lands. */
  current(): NativeLeaseSettingsOverride {
    return this.override
  }

  /**
   * Re-read if the cached value has expired. Concurrent callers share one
   * in-flight read; a failure keeps the LAST KNOWN value rather than reverting
   * to `{}`, because a revert would silently hand the next-spawned workers a
   * different RAM profile than the ones already running.
   */
  async refresh(api: NativeLeaseSettingsApi | undefined): Promise<NativeLeaseSettingsOverride> {
    if (api === undefined) return this.override
    if (this.now() - this.lastReadAtMs < this.ttlMs) return this.override
    this.inFlight ??= this.read(api).finally(() => {
      this.inFlight = null
    })
    await this.inFlight
    return this.override
  }

  private async read(api: NativeLeaseSettingsApi): Promise<void> {
    try {
      const view = await api.addonSettings.getGlobalSettings.query({
        addonId: NATIVE_LEASE_OWNER_ADDON_ID,
      })
      const next = pickNativeLeaseOverride(view)
      this.lastReadAtMs = this.now()
      if (sameOverride(next, this.override)) return
      // The one line that explains a step-change in worker RSS or in native-crop
      // hit rate. Without it, "the workers got bigger on Tuesday" has no anchor.
      this.logger.info('native lease settings changed — applies to NEW decode sessions', {
        meta: { from: { ...this.override }, to: { ...next } },
      })
      this.override = next
    } catch (err: unknown) {
      // Not fatal, but never silent: an unreadable knob means every worker
      // spawned from here on runs a value the operator may not have chosen.
      this.logger.warn('native lease settings read failed — keeping the last known value', {
        meta: {
          owner: NATIVE_LEASE_OWNER_ADDON_ID,
          inUse: { ...this.override },
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }
}
