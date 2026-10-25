/**
 * The recorder's own mirror of `recorder:recording-configs` — the ONE place
 * the controller's config reads are answered from.
 *
 * Supersedes `last-known-config.ts` (deleted with this module's arrival): that
 * file held the same map for one job, and this one does both jobs off ONE copy.
 * Two caches of one fact in one addon is the defect this repo keeps writing
 * records about, so there is exactly one.
 *
 * ## Job 1 — a decision on the trigger path costs nothing (D466)
 *
 * `RecordingController` reads a camera's `RecordingConfig` on six paths, and
 * three of them run at EVENT-BUS RATE: `onAudioLevel` (one
 * `PipelineAudioInferenceResult` per audio window per camera),
 * `postBufferMsFor` (every qualifying motion/object/audio trigger) and
 * `evaluateDevice` (every reconcile beat and every trigger). Each read was a
 * UDS round trip through hub-main to `hub/sqlite-settings`.
 *
 * Measured on the live hub 2026-09-11, from the engine's own profiler
 * (`sqlite engine busy`, 60 s windows): `get recorder:recording-configs` at
 * **1 453-1 820 calls/min**, ~40 % of every call the whole cluster made to the
 * settings store (3 180-5 369/min), and it found a row only ~64 % of the time.
 * The recorder's `debug.storeCensus` had already attributed 8 693 of 8 733
 * reads in a 300 s window to one site — `RowMapStore.read < loadDeviceConfig <
 * load` — and could not say which of the six callers it was, because all six go
 * through the same arrow function and the census keeps three frames.
 *
 * The answer to a question asked at bus rate about a row an operator edits
 * every few weeks is a mirror, not a poll.
 *
 * ## Job 2 — the failed read that became a wrong number on disk
 *
 * On 2026-08-25, between 09:29 and 09:58, the settings door returned
 * `UDS request timed out after 60000ms` **57 times to the recorder alone**
 * (the container sat at 22.0 GiB of a 24 GiB `memory.max`; every process in it
 * stalled in direct reclaim together). The recorder logged:
 *
 * ```
 * [Camera kitchen] recorder: trigger history using the DEFAULT post-buffer
 *   — config read failed {atMs=… error="UDS request timed out after 60000ms"}
 * ```
 *
 * The post-buffer is both the merge gap and the retention horizon for the
 * episode, so a read that failed made the recorder **write footage bounded by
 * the shipped default instead of by the operator's band** — a wrong number,
 * persisted, on a camera that was configured correctly the whole time. A value
 * read five minutes ago is very close to the truth; the shipped default is not
 * close at all, so a failure serves the last value that succeeded.
 *
 * There is deliberately **no TTL on that fallback**. A TTL would mean "after N
 * minutes, go back to writing the wrong number". Staleness is made VISIBLE
 * instead: every fallback logs the age of the value it served.
 *
 * ## Why this is not the cache D224 forbids
 *
 * D224 forbids a CONSUMER keeping a second copy of a fact another addon owns —
 * "stale by design on the one write an operator makes". This addon **is** the
 * owner: `recorder:recording-configs` is written by `saveDeviceConfig` and by
 * nothing else, from the `recording` cap's own `setDeviceConfig` handler, in
 * this process. So the mirror is written THROUGH ({@link
 * RecordingConfigMirror.put}) with the value that was just persisted, and an
 * operator's edit is visible on the very next decision — zero window, not
 * `freshMs` later. {@link RecordingConfigMirror.invalidate} exists for the
 * paths that change a row without holding its new value.
 *
 * The freshness window therefore covers only a write that reached the row
 * without passing through this process — a boot migration
 * (`migrateLegacyDeviceSignalRows`, which runs before the controller starts) or
 * a future second writer. It is bounded so that such a write converges without
 * anyone having to remember this file exists.
 *
 * The operator-facing reads (`getDeviceConfig`, `getStatus`, `rescanStorage`,
 * `pruneFootage` in `recording-provider.ts`) deliberately keep reading the row
 * directly: they are a handful a minute, and a UI that shows a config must show
 * the persisted one.
 */

import type { IScopedLogger, RecordingConfig } from '@camstack/types'
import { errMsg } from '@camstack/types/addon'

/** Reads one camera's config from the store. The wrapped, fallible call. */
export type LoadDeviceConfigFn = (deviceId: number) => Promise<RecordingConfig>

/**
 * How long a mirrored config answers the trigger path without a store read.
 *
 * 30 s is not a guess about how fast an operator edit must land — an edit lands
 * IMMEDIATELY through {@link RecordingConfigMirror.put}, and this window never
 * delays one. It is the bound on a write that bypassed this process entirely,
 * and 30 s turns the live 1 453-1 820 reads/min into at most two per camera per
 * minute (~26/min on this hub's 13 recording cameras) while still converging
 * inside one reconcile beat of any such write.
 */
export const RECORDING_CONFIG_FRESH_MS = 30_000

/** How often the mirror states what it served and what it cost, in ms.
 *  Matched to the `[mem]`/profiler heartbeat so the lines read side by side. */
export const RECORDING_CONFIG_REPORT_MS = 60_000

export interface RecordingConfigMirrorDeps {
  readonly load: LoadDeviceConfigFn
  readonly logger: IScopedLogger
  /** Injected so a test can advance time without sleeping. */
  readonly now?: () => number
  readonly freshMs?: number
  readonly reportIntervalMs?: number
}

/** The recorder's config read, plus the two handles its owner needs. */
export interface RecordingConfigMirror {
  /** The controller's read — a drop-in {@link LoadDeviceConfigFn}. */
  readonly read: LoadDeviceConfigFn
  /**
   * Write through: the value this addon just persisted for `deviceId`. Makes an
   * operator edit visible on the next decision, with no window.
   */
  put(deviceId: number, config: RecordingConfig): void
  /** Drop one camera's entry — the next read goes to the store. */
  invalidate(deviceId: number): void
}

interface MirroredConfig {
  readonly config: RecordingConfig
  /** When the value was last known to match the row. */
  readonly atMs: number
}

interface MirrorWindow {
  served: number
  storeReads: number
  fallbacks: number
  startedAt: number
}

/**
 * Build the recorder's config mirror.
 *
 * `load` is the fallible store read (`loadDeviceConfig(configStore, id)`), and
 * every existing call site keeps its signature: the controller is handed
 * {@link RecordingConfigMirror.read} and cannot tell the difference, which is
 * the point — the trigger post-buffer is the path that got CAUGHT writing a
 * wrong number, but it is one of six reads and the other five are the volume.
 */
export function createRecordingConfigMirror(
  deps: RecordingConfigMirrorDeps,
): RecordingConfigMirror {
  const now = deps.now ?? ((): number => Date.now())
  const freshMs = deps.freshMs ?? RECORDING_CONFIG_FRESH_MS
  const reportIntervalMs = deps.reportIntervalMs ?? RECORDING_CONFIG_REPORT_MS
  const mirror = new Map<number, MirroredConfig>()
  const window: MirrorWindow = { served: 0, storeReads: 0, fallbacks: 0, startedAt: now() }

  /**
   * One line per window, fleet-level (no `deviceId`: this aggregates every
   * camera, and the per-camera lines are the fallback WARNs above).
   *
   * It exists because a branch that ACCEPTS work and produces no store traffic
   * is indistinguishable from a branch nobody calls: without this line, a
   * mirror that silently stopped mirroring and a mirror doing its job both look
   * like silence, and the only visible difference is 1 800 calls a minute on a
   * runner nobody is watching.
   */
  const reportIfDue = (atMs: number): void => {
    const windowMs = atMs - window.startedAt
    if (windowMs < reportIntervalMs) return
    const calls = window.served + window.storeReads
    window.startedAt = atMs
    const served = window.served
    const storeReads = window.storeReads
    const fallbacks = window.fallbacks
    window.served = 0
    window.storeReads = 0
    window.fallbacks = 0
    if (calls === 0) return
    deps.logger.info('recorder: config mirror window', {
      meta: {
        served,
        storeReads,
        fallbacks,
        devices: mirror.size,
        windowMs,
        freshMs,
      },
    })
  }

  const read = async (deviceId: number): Promise<RecordingConfig> => {
    const atMs = now()
    reportIfDue(atMs)
    const held = mirror.get(deviceId)
    if (held !== undefined && atMs - held.atMs < freshMs) {
      window.served += 1
      return held.config
    }
    window.storeReads += 1
    try {
      const config = await deps.load(deviceId)
      // Only a SUCCESSFUL read updates the mirror. A rejected promise never
      // reaches here, so a failure can never overwrite good state with an empty
      // one — the D44 direction of this bug.
      mirror.set(deviceId, { config, atMs: now() })
      return config
    } catch (err: unknown) {
      const cached = mirror.get(deviceId)
      if (cached === undefined) {
        // Nothing was ever read for this camera. There is no honest answer
        // here, so do not invent one: rethrow and let the caller's own fallback
        // decide, which is the only place that knows what a missing config
        // means for the operation in flight.
        deps.logger.warn(
          'recorder: config read failed and NOTHING is cached for this camera — no last-known-good to serve',
          { tags: { deviceId }, meta: { error: errMsg(err) } },
        )
        throw err
      }
      window.fallbacks += 1
      deps.logger.warn(
        'recorder: config read failed — serving the LAST-KNOWN-GOOD config (not the shipped default)',
        { tags: { deviceId }, meta: { ageMs: now() - cached.atMs, error: errMsg(err) } },
      )
      return cached.config
    }
  }

  return {
    read,
    put(deviceId: number, config: RecordingConfig): void {
      mirror.set(deviceId, { config, atMs: now() })
    },
    invalidate(deviceId: number): void {
      mirror.delete(deviceId)
    },
  }
}
