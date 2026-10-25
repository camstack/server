/**
 * From `DeviceStateChanged` to "which cameras must record".
 *
 * Two responsibilities, both in RAM and neither durable:
 *  - the edge MEMORY, per `(deviceId, capName)`, which makes `false→true`
 *    distinguishable from a re-emission. The predicate is `evaluateSensorEdge`
 *    (`@camstack/types`) — the same `SOURCE_CAP_ACTIVE_FIELD` table as the
 *    composite doorbell and the camera-sensors bridge, not a copy;
 *  - the INVERSE INDEX source→cameras, a mirrored state refreshed OFF
 *    the event path (D49): `setBindings` is called at boot from the
 *    already-read configs and on every `onConfigChanged`, which is an RPC. A
 *    fallible read on the trigger path could answer "nobody listens"
 *    and lose the episode, which is the failure D49 is written against.
 *
 * The order of the checks is deliberate: `DeviceStateChanged` travels at bus
 * rate across the whole fleet (battery, every camera's native `motion`,
 * connectivity). The inverse index is an allocation-free `Map.get` and goes
 * first; the edge — which reads two tables and the slice — comes after. It is the same
 * choice post-analysis makes for its subscription: *"the
 * EVENT_KIND_BY_CAP gate runs FIRST so non-sensor cap churn exits before any
 * async work"*.
 *
 * Pure with respect to the world: no bus, no logger, no clock of its own.
 * The caller logs the verdict — a branch that lights nothing SAYS so.
 */
import { evaluateSensorEdge, DEFAULT_FIRST_SIGHTING_FRESHNESS_MS } from '@camstack/types'
import type { RecordingConfig, SensorEdgeIgnoreReason } from '@camstack/types'

/**
 * The `DeviceStateChanged` payload this router consumes. Only what it reads is
 * declared — the emitter carries more, and re-declaring the rest here would be
 * a second copy of a shape that is not ours.
 */
export interface SensorStateChange {
  readonly deviceId: number
  readonly capName: string
  readonly slice: Readonly<Record<string, unknown>>
}

/**
 * Type GUARD, not a cast: `event.data` is `unknown`, and a version-skewed
 * emitter must leave this router untouched rather than route a `deviceId` of
 * `undefined`. Same discipline as `parseTopologySnapshotNodes`.
 *
 * A missing or non-object `slice` is REFUSED rather than defaulted to `{}`:
 * `evaluateSensorEdge` would read `non-boolean-value` from an empty object and
 * that would look like a sensor reporting nonsense, when what actually
 * happened is that there was nothing to read.
 */
export function parseSensorStateChanged(data: unknown): SensorStateChange | null {
  if (typeof data !== 'object' || data === null) return null
  if (!('deviceId' in data) || typeof data.deviceId !== 'number') return null
  if (!('capName' in data) || typeof data.capName !== 'string') return null
  if (!('slice' in data) || typeof data.slice !== 'object' || data.slice === null) return null
  const slice: Readonly<Record<string, unknown>> = { ...data.slice }
  return { deviceId: data.deviceId, capName: data.capName, slice }
}

/**
 * sourceDeviceId → cameras whose config names it.
 *
 * From EVERY band, not only the one active now: the index only changes on a
 * config write, while the active band changes with the clock, and an index
 * that followed the clock would lose the first trigger after every band edge.
 * Filtering by band is already the gate's job — `bandTriggerSources` reads the
 * band active at the instant of evaluation.
 *
 * A disabled camera is skipped: it records nothing whatever a sensor does, and
 * it re-enters through `onConfigChanged`, which rebuilds this.
 */
export function buildSensorTriggerBindings(
  configs: ReadonlyMap<number, RecordingConfig>,
): ReadonlyMap<number, ReadonlySet<number>> {
  const index = new Map<number, Set<number>>()
  for (const [cameraId, config] of configs) {
    if (config.enabled !== true) continue
    for (const band of config.bands ?? []) {
      for (const sourceDeviceId of band.triggers?.sensorDeviceIds ?? []) {
        const cameras = index.get(sourceDeviceId) ?? new Set<number>()
        cameras.add(cameraId)
        index.set(sourceDeviceId, cameras)
      }
    }
  }
  return index
}

/** Why a slice did not light any camera. */
export type SensorRouteSkipReason =
  | SensorEdgeIgnoreReason
  /** No band names this source device. The vast majority
   *  of the bus traffic, and NOT a loss. */
  | 'not-listened'

export interface SensorRouteResult {
  /** The cameras to wake now. */
  readonly fired: readonly number[]
  /** Set when `fired` is empty; null when an edge was routed. */
  readonly skipped: SensorRouteSkipReason | null
}

export interface SensorTriggerRouterOptions {
  readonly now: () => number
  /** When this router started watching. On a freshly
   *  respawned runner it is "now", and it is the floor of the freshness rule. */
  readonly startedAtMs: number
  readonly firstSightingFreshnessMs?: number
}

export class SensorTriggerRouter {
  /** sourceDeviceId → cameras whose config names it. */
  private bindings: ReadonlyMap<number, ReadonlySet<number>> = new Map()
  /** Ultimo booleano osservato, per `${deviceId}:${capName}`. */
  private readonly lastValues = new Map<string, boolean>()
  private readonly now: () => number
  private readonly startedAtMs: number
  private readonly freshnessMs: number

  constructor(options: SensorTriggerRouterOptions) {
    this.now = options.now
    this.startedAtMs = options.startedAtMs
    this.freshnessMs = options.firstSightingFreshnessMs ?? DEFAULT_FIRST_SIGHTING_FRESHNESS_MS
  }

  /**
   * Replaces the inverse index. Does NOT touch `lastValues`: a sensor removed and
   * put back into a band must find its previous level again, otherwise
   * the first slice after the return would be a "first observation" and a
   * contact left open the whole time would become a rising edge.
   */
  setBindings(bindings: ReadonlyMap<number, ReadonlySet<number>>): void {
    this.bindings = bindings
  }

  /** Which sources the index holds now — for the log line at boot. */
  listenedSourceIds(): readonly number[] {
    return [...this.bindings.keys()]
  }

  onStateSlice(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
  ): SensorRouteResult {
    const cameras = this.bindings.get(deviceId)
    if (cameras === undefined || cameras.size === 0) {
      return { fired: [], skipped: 'not-listened' }
    }
    const key = `${deviceId}:${capName}`
    const verdict = evaluateSensorEdge({
      capName,
      slice,
      prior: this.lastValues.get(key),
      startedAtMs: this.startedAtMs,
      nowMs: this.now(),
      firstSightingFreshnessMs: this.freshnessMs,
    })
    if (verdict.edge === 'none') {
      // The memory is updated only when the slice CARRIED a boolean: on
      // `unknown-cap` / `non-boolean-value` there is nothing to remember.
      if (verdict.value !== null) this.lastValues.set(key, verdict.value)
      return { fired: [], skipped: verdict.reason }
    }
    this.lastValues.set(key, true)
    return { fired: [...cameras], skipped: null }
  }
}
