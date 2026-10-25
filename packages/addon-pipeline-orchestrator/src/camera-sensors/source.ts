/**
 * The camera-sensors bridge (D672, D673): the ONE emitter of a camera's
 * EFFECTIVE onboard motion — `MotionOnMotionChanged { source: 'onboard',
 * triggeredBy }`. A camera provider pushes its RAW onboard motion on
 * `ProviderMotion`; this class re-emits it, combined with the sensors the
 * operator attached, under the rule in `effective-motion.ts`.
 *
 * - No sensor, nothing forwarded, or nothing resolved yet: the raw push goes
 *   out verbatim, named as the camera (C7, fail open — never less camera
 *   motion than before CS-2).
 * - Otherwise each input is combined (C2–C5): an In-addition / Replace sensor
 *   level is motion; the camera's own motion counts unless a READY Replace
 *   sensor replaces it or a READY Confirm sensor gates it (the controller's
 *   ruling on Q1). A dropped camera edge is SAID, sampled (C9).
 * - Edges (C8): the effective level rises with a FRESH first trigger (C10),
 *   every counted `true` is forwarded while it holds, a `false` goes out only
 *   when an input's own `false` (or a removal, or a stuck release) leaves no
 *   motion, and the level expires one cooldown after its last `true`.
 * - Sustain ticks run only while a sensor level holds the motion (C11).
 * - A provider that still emits `MotionOnMotionChanged` directly (not split,
 *   C13) is noted as the camera's level and reported `notEnforced`.
 *
 * The sensor LEVEL is mirrored here, refreshed from `DeviceStateChanged` and
 * never read back from the device (D224); a rise is the shared
 * `evaluateSensorEdge` (first-sighting freshness included, so a boot hydration
 * of a long-active sensor is not a rise). No I/O: every read here is memory or
 * a synchronous dep over memory (D49).
 */
import {
  CAMERA_TRIGGER,
  type CameraRawLevel,
  type CameraSensorMode,
  type CameraSensorsNotEnforced,
  DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
  evaluateSensorEdge,
  type IScopedLogger,
  type MotionOnMotionChangedData,
  type MotionSources,
  type MotionTriggeredBy,
  sliceChangedAt,
} from '@camstack/types'
import {
  cameraOwnMotionRule,
  type EffectiveMotion,
  effectiveMotion,
  type SensorInputState,
  sensorActive,
} from './effective-motion.js'
import { notForwardedReason } from './forwarding.js'

/** The wire source an attached sensor's rise is emitted under: the camera's own. */
export { CAMERA_SENSORS_SOURCE } from './forwarding.js'

type MotionRegions = MotionOnMotionChangedData['regions']

export interface CameraSensorsMotion {
  readonly deviceId: number
  readonly detected: boolean
  readonly timestamp: number
  readonly triggeredBy: MotionTriggeredBy
  readonly regions?: MotionRegions
}

/** A camera's RAW push, as `ProviderMotion` carries it. */
export interface CameraMotionEdge {
  readonly deviceId: number
  readonly detected: boolean
  readonly timestamp: number
  readonly regions?: MotionRegions
}

export interface CameraSensorsSourceDeps {
  readonly logger: IScopedLogger
  /** Emit `MotionOnMotionChanged { source: 'onboard', triggeredBy }` for the CAMERA. */
  readonly emitMotion: (motion: CameraSensorsMotion) => void
  /** In-memory read of the camera's active config (`activeDetections`); `null` = no active detection. */
  readonly motionSourcesFor: (cameraId: number) => MotionSources | null
  readonly sustainMsFor: (cameraId: number) => number
  /**
   * The camera's `motionCooldownMs`: how long its own last `true` counts as
   * "still seeing motion", how long a Confirm sensor keeps confirming after it
   * fell, and how long the effective level holds after its last `true`.
   */
  readonly cooldownMsFor: (cameraId: number) => number
  /** The camera's `maxSessionHoldMs`: how long a sensor stays active with no NEW rise (C5). */
  readonly maxHoldMsFor: (cameraId: number) => number
  readonly now: () => number
}

/** The camera's own last onboard edge, and when it arrived. */
interface CameraLevel {
  readonly detected: boolean
  readonly atMs: number
}

/** One sensor routed to a camera, as the resolver decided it (D673 C1, C3). */
export interface CameraSensorInput {
  readonly deviceId: number
  readonly mode: CameraSensorMode
  /** C3: only a ready Replace / Confirm sensor reshapes the camera's own motion. */
  readonly ready: boolean
}

export interface SensorStateInput {
  readonly sensorId: number
  readonly capName: string
  readonly slice: Readonly<Record<string, unknown>>
  readonly observedAtMs: number
}

/** One `(sensor, cap)` level and its two clocks. */
interface SensorLevel {
  readonly high: boolean
  /** Its last REAL rise (an edge); null = never seen rising. */
  readonly lastRiseAt: number | null
  readonly lastFallAt: number | null
}

/** Per camera with attached sensors. */
interface CameraAggregate {
  inputs: ReadonlyMap<number, CameraSensorInput>
  /** The input whose event made the effective motion rise (C10); null while low. */
  firstTrigger: MotionTriggeredBy | null
  /** When the last effective `true` went out; the effective level expires one cooldown later (C8). */
  lastEffectiveTrueAt: number | null
  /**
   * Consumers were sent a `true` and no `false` since — independent of the
   * cooldown: an input's own `false` must reach them even after the effective
   * level expired (the HA / Alexa exports have no quiet timer of their own).
   */
  owesFalse: boolean
  timer: NodeJS.Timeout | null
  /** Camera edges dropped since the aggregate exists — sampled line (C9). */
  dropped: number
  /** Sensors already said to be stuck in this episode (C5). */
  readonly stuckSaid: Set<number>
}

/** The sensor that raised the motion, on the rise line. */
interface SensorTriggerMeta {
  readonly sourceDeviceId: number
  readonly capName: string
}

/** A rise/fall edge, or a sustain tick re-asserting a level already said. */
type EmitKind = 'edge' | 'tick'

/** The sampled "camera motion not counted" line: the first, then every Nth (D672 rule 13's rule). */
const DROP_SAMPLE_EVERY = 50

function levelKey(sensorId: number, capName: string): string {
  return `${sensorId}#${capName}`
}

function isKeyOf(key: string, sensorId: number): boolean {
  return key.startsWith(`${sensorId}#`)
}

/** A sensor level (In-addition / Replace) holds the motion — the sustain's condition (C11). */
function sensorHeld(verdict: EffectiveMotion): boolean {
  return verdict.support.includes('in-addition') || verdict.support.includes('replace')
}

/** The camera's own motion counts right now. */
function cameraCounts(verdict: EffectiveMotion): boolean {
  return verdict.support.includes('camera') || verdict.support.includes('camera-confirmed')
}

function latest(values: readonly (number | null)[]): number | null {
  return values.reduce<number | null>(
    (acc, v) => (v === null ? acc : acc === null ? v : Math.max(acc, v)),
    null,
  )
}

/**
 * How long a camera's motion level holds after its last `true`: the camera's
 * `motionCooldownMs`, floored at two sustain intervals (task 12 review H3). One
 * rule for the bridge's effective level and the camera's `motion` slice (D696).
 */
export function effectiveWindowMs(cooldownMs: number, sustainMs: number): number {
  return Math.max(cooldownMs, 2 * sustainMs)
}

export class CameraSensorsSource {
  readonly #deps: CameraSensorsSourceDeps
  readonly #camerasBySensor: Map<number, Set<number>> = new Map()
  /** Per sensor: when it was first watched — the edge predicate's `startedAtMs`. */
  readonly #watchStartedAt: Map<number, number> = new Map()
  /** The level mirror, keyed `${sensorId}#${capName}`. */
  readonly #levels: Map<string, SensorLevel> = new Map()
  readonly #cameras: Map<number, CameraAggregate> = new Map()
  /** The camera's OWN onboard level — from its raw push, or a direct (unsplit) emit. */
  readonly #cameraLevels: Map<number, CameraLevel> = new Map()
  /** Cameras whose provider still emits `MotionOnMotionChanged` directly (C13). */
  readonly #direct: Set<number> = new Set()
  /** Cameras already warned about an unsplit provider — once per camera and process (C13). */
  readonly #directSaid: Set<number> = new Set()
  /** Cameras whose PASS-THROUGH `true` has not been followed by a `false` yet (task 12 review H2). */
  readonly #passOwed: Set<number> = new Set()
  #stopped = false

  constructor(deps: CameraSensorsSourceDeps) {
    this.#deps = deps
  }

  /** Replace the sensors that drive `cameraId`. A change that leaves no motion emits the camera's `false`. */
  setInputs(cameraId: number, inputs: readonly CameraSensorInput[]): void {
    if (this.#stopped) return
    const next = new Map(inputs.map((input) => [input.deviceId, input] as const))
    const current = this.#sensorsOf(cameraId)
    for (const sensorId of next.keys()) {
      if (!current.includes(sensorId)) this.#watch(cameraId, sensorId)
    }
    for (const sensorId of current) if (!next.has(sensorId)) this.#unwatch(cameraId, sensorId)
    const agg = this.#cameras.get(cameraId)
    if (agg === undefined) {
      if (next.size > 0) {
        // A pass-through `true` already reached consumers (a respawn, a first attach): its `false`
        // is owed whatever the combining says from now on (task 12 review H2).
        const owed = this.#passOwed.delete(cameraId)
        this.#cameras.set(cameraId, {
          inputs: next,
          firstTrigger: owed ? CAMERA_TRIGGER : null,
          lastEffectiveTrueAt: owed ? (this.#cameraLevels.get(cameraId)?.atMs ?? null) : null,
          owesFalse: owed,
          timer: null,
          dropped: 0,
          stuckSaid: new Set(),
        })
      }
      return
    }
    agg.inputs = next
    this.#settle(cameraId, agg, this.#deps.now())
    if (next.size === 0) {
      this.#clearTimer(agg)
      this.#cameras.delete(cameraId)
    }
  }

  /** Cheap gate for the subscription: is any camera fed by this device? */
  watches(sensorId: number): boolean {
    return this.#camerasBySensor.has(sensorId)
  }

  onSensorState(input: SensorStateInput): void {
    if (this.#stopped) return
    const { sensorId, capName, slice, observedAtMs } = input
    const cameras = this.#camerasBySensor.get(sensorId)
    if (cameras === undefined || cameras.size === 0) return
    const key = levelKey(sensorId, capName)
    const prior = this.#levels.get(key)
    const verdict = evaluateSensorEdge({
      capName,
      slice,
      prior: prior?.high,
      startedAtMs: this.#watchStartedAt.get(sensorId) ?? observedAtMs,
      nowMs: observedAtMs,
      firstSightingFreshnessMs: DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
    })
    if (verdict.value === null) {
      this.#deps.logger.debug('camera-sensors: slice carries no level — ignored', {
        tags: { deviceId: sensorId },
        meta: { capName, reason: verdict.reason },
      })
      return
    }
    const now = this.#deps.now()
    const lastFallAt = prior?.lastFallAt ?? null

    if (verdict.edge === 'rising') {
      const at = sliceChangedAt(capName, slice)
      if (at === null) {
        // A rise with no timestamp never counts (C5): it is stored, never risen.
        this.#levels.set(key, { high: true, lastRiseAt: null, lastFallAt })
        this.#sayNotForwarded(cameras, sensorId, capName, 'missing-timestamp')
        return
      }
      this.#levels.set(key, { high: true, lastRiseAt: now, lastFallAt })
      for (const cameraId of cameras) this.#sensorRise(cameraId, sensorId, capName, at)
      return
    }
    if (verdict.value) {
      // Still high (or a stale first sighting): the clocks stand.
      this.#levels.set(key, { high: true, lastRiseAt: prior?.lastRiseAt ?? null, lastFallAt })
      if (
        verdict.reason === 'baseline-seeded-stale-active' ||
        verdict.reason === 'missing-timestamp'
      ) {
        this.#sayNotForwarded(cameras, sensorId, capName, verdict.reason)
      }
      return
    }
    const wasHigh = prior?.high === true
    this.#levels.set(key, {
      high: false,
      lastRiseAt: prior?.lastRiseAt ?? null,
      lastFallAt: wasHigh ? now : lastFallAt,
    })
    if (!wasHigh) return
    for (const cameraId of cameras) {
      const agg = this.#cameras.get(cameraId)
      if (agg !== undefined) this.#settle(cameraId, agg, observedAtMs)
    }
  }

  /** A raw camera push: pass-through (C7) or combined (C2–C11). */
  onCameraMotion(edge: CameraMotionEdge): void {
    if (this.#stopped) return
    // A raw push means this camera's provider is split now (a roll-forward after a
    // provider rollback): the unsplit mark and its once-only warning are stale.
    this.#direct.delete(edge.deviceId)
    this.#directSaid.delete(edge.deviceId)
    const agg = this.#cameras.get(edge.deviceId)
    if (
      agg === undefined ||
      notForwardedReason(this.#deps.motionSourcesFor(edge.deviceId)) !== null
    ) {
      this.#passThrough(edge)
      return
    }
    const seen = this.#cameraLevels.has(edge.deviceId)
    this.#cameraLevels.set(edge.deviceId, { detected: edge.detected, atMs: this.#deps.now() })
    const verdict = this.#evaluate(edge.deviceId, agg)
    if (!edge.detected) {
      // A clear for a camera whose rise this instance never saw (a respawn): consumers in other
      // processes (HA export, Alexa) saw the OLD instance's true and have no reset of their own.
      // Nothing owed and nothing held → pass it on; a redundant false is idempotent downstream.
      if (!seen && !agg.owesFalse && !verdict.high) {
        this.#deps.logger.debug(
          'camera-sensors: camera clear passed — this instance never saw its rise',
          { tags: { deviceId: edge.deviceId } },
        )
        this.#passThrough(edge)
        return
      }
      this.#settle(edge.deviceId, agg, edge.timestamp, verdict)
      return
    }
    if (!cameraCounts(verdict)) {
      this.#sayDropped(edge.deviceId, agg, verdict)
      return
    }
    if (!this.#isHigh(edge.deviceId, agg)) this.#open(edge.deviceId, agg, CAMERA_TRIGGER, verdict)
    this.#emitTrue(edge.deviceId, agg, edge.timestamp, 'edge', edge.regions)
  }

  /** An unsplit provider's direct emit (C13): the camera's level only, never re-emitted. */
  noteDirectCameraMotion(cameraId: number, detected: boolean): void {
    if (this.#stopped) return
    this.#cameraLevels.set(cameraId, { detected, atMs: this.#deps.now() })
    this.#direct.add(cameraId)
    const reason = this.enforcementOf(cameraId)
    if (reason === null || this.#directSaid.has(cameraId)) return
    this.#directSaid.add(cameraId)
    this.#deps.logger.warn(
      'camera-sensors: camera motion arrives unsplit — confirm/replace cannot suppress it',
      { tags: { deviceId: cameraId }, meta: { reason } },
    )
  }

  /**
   * The camera's OWN onboard level as this bridge received it (raw, never
   * effective): from its raw push, or an unsplit provider's direct emit. The
   * Motion card's camera row reads it, because the camera's `motion` slice is
   * the effective value (D696). Null = nothing received since this instance
   * started (unknown, never "quiet").
   */
  cameraLevelOf(cameraId: number): CameraRawLevel | null {
    const level = this.#cameraLevels.get(cameraId)
    if (level === undefined) return null
    // Evaluated NOW, against the same window the bridge counts the camera's own
    // motion for: a heartbeat-only camera (no clear, ever) reads idle once no
    // push came within it (review F4).
    const fresh = this.#deps.now() - level.atMs < this.#windowMs(cameraId)
    return { detected: level.detected && fresh, atMs: level.atMs }
  }

  /** `provider-not-split` while an unsplit camera's own motion is not `always` (C13); from memory. */
  enforcementOf(cameraId: number): CameraSensorsNotEnforced | null {
    const agg = this.#cameras.get(cameraId)
    if (agg === undefined || !this.#direct.has(cameraId)) return null
    return cameraOwnMotionRule([...agg.inputs.values()]) === 'always' ? null : 'provider-not-split'
  }

  /**
   * True while an attached sensor of this camera holds the motion. Scoped to C13: block 9b withholds an
   * UNSPLIT provider's direct clear from the session while this is true (the bridge's own sensor false
   * then closes it). Remove only when no unsplit emitter remains in the tree (the emitter guard's
   * `MOTION_EMITTERS_DEFERRED` is empty) and the minimum provider versions carry Task 14: camera-grid is
   * still unsplit, and a provider-only rollback recreates unsplit providers.
   */
  sensorHolds(cameraId: number): boolean {
    const agg = this.#cameras.get(cameraId)
    return agg !== undefined && sensorHeld(this.#evaluate(cameraId, agg))
  }

  removeCamera(cameraId: number): void {
    this.#cameraLevels.delete(cameraId)
    this.#direct.delete(cameraId)
    this.#directSaid.delete(cameraId)
    this.#passOwed.delete(cameraId)
    this.setInputs(cameraId, [])
    const agg = this.#cameras.get(cameraId)
    if (agg !== undefined) this.#clearTimer(agg)
    this.#cameras.delete(cameraId)
  }

  stop(): void {
    this.#stopped = true
    for (const agg of this.#cameras.values()) this.#clearTimer(agg)
    this.#cameras.clear()
    this.#cameraLevels.clear()
    this.#camerasBySensor.clear()
    this.#watchStartedAt.clear()
    this.#levels.clear()
    this.#direct.clear()
    this.#directSaid.clear()
    this.#passOwed.clear()
  }

  #sensorsOf(cameraId: number): readonly number[] {
    return [...this.#camerasBySensor].flatMap(([sensorId, cameras]) =>
      cameras.has(cameraId) ? [sensorId] : [],
    )
  }

  #watch(cameraId: number, sensorId: number): void {
    if (!this.#watchStartedAt.has(sensorId)) this.#watchStartedAt.set(sensorId, this.#deps.now())
    const cameras = this.#camerasBySensor.get(sensorId) ?? new Set<number>()
    cameras.add(cameraId)
    this.#camerasBySensor.set(sensorId, cameras)
  }

  /** The mapping and level clean-up only — the aggregate's `false` is `#settle`'s job. */
  #unwatch(cameraId: number, sensorId: number): void {
    const cameras = this.#camerasBySensor.get(sensorId)
    cameras?.delete(cameraId)
    if (cameras !== undefined && cameras.size === 0) {
      this.#camerasBySensor.delete(sensorId)
      this.#watchStartedAt.delete(sensorId)
      for (const key of [...this.#levels.keys()]) {
        if (isKeyOf(key, sensorId)) this.#levels.delete(key)
      }
    }
  }

  #evaluate(cameraId: number, agg: CameraAggregate): EffectiveMotion {
    return effectiveMotion({
      now: this.#deps.now(),
      cooldownMs: this.#windowMs(cameraId),
      maxHoldMs: this.#deps.maxHoldMsFor(cameraId),
      camera: this.#cameraLevels.get(cameraId) ?? null,
      sensors: [...agg.inputs.values()].map((input) => this.#sensorState(input)),
    })
  }

  #sensorState(input: CameraSensorInput): SensorInputState {
    const levels = [...this.#levels]
      .filter(([key]) => isKeyOf(key, input.deviceId))
      .map(([, level]) => level)
    const high = levels.some((l) => l.high)
    const lastRiseAt = latest(levels.map((l) => l.lastRiseAt))
    // A Replace sensor first seen ALREADY high never counts (no fake rise), so it must not replace
    // the camera either until its first real edge: hand the camera back meanwhile (task 12 review M1).
    const staleReplace = input.mode === 'replace' && high && lastRiseAt === null
    return {
      mode: input.mode,
      ready: input.ready && !staleReplace,
      high,
      // A Confirm sensor first seen ALREADY high (a respawn, a late attach) confirms from the moment
      // it was watched, bounded by maxSessionHoldMs like any rise: the stale-first-sighting rule exists
      // to stop a fake EMITTED rise, and a Confirm emits nothing on its own (task 10 review M3).
      lastRiseAt:
        input.mode === 'confirm' && high && lastRiseAt === null
          ? (this.#watchStartedAt.get(input.deviceId) ?? null)
          : lastRiseAt,
      lastFallAt: latest(levels.map((l) => l.lastFallAt)),
    }
  }

  /**
   * The activity window: the camera's `motionCooldownMs`, floored at two sustain intervals. A
   * cooldown at or under the sustain interval (the cap allows 0) would make the camera's own
   * motion never count and expire the effective level between two ticks (task 12 review H3).
   */
  #windowMs(cameraId: number): number {
    return effectiveWindowMs(this.#deps.cooldownMsFor(cameraId), this.#deps.sustainMsFor(cameraId))
  }

  /** The effective level: an effective `true` younger than one window (C8). */
  #isHigh(cameraId: number, agg: CameraAggregate): boolean {
    return (
      agg.lastEffectiveTrueAt !== null &&
      this.#deps.now() - agg.lastEffectiveTrueAt < this.#windowMs(cameraId)
    )
  }

  #open(
    cameraId: number,
    agg: CameraAggregate,
    trigger: MotionTriggeredBy,
    verdict: EffectiveMotion,
    sensor?: SensorTriggerMeta,
  ): void {
    agg.firstTrigger = trigger
    agg.stuckSaid.clear()
    const confirmedBy = verdict.support.includes('camera-confirmed')
      ? trigger.kind === 'camera'
        ? this.#activeConfirms(cameraId, agg)
        : 'camera'
      : undefined
    const meta = {
      triggeredBy: trigger,
      support: verdict.support,
      cameraMotion: verdict.cameraMotion,
      ...(confirmedBy === undefined ? {} : { confirmedBy }),
      ...sensor,
    }
    if (trigger.kind === 'sensor') {
      this.#deps.logger.info('camera-sensors: attached sensor triggered camera motion', {
        tags: { deviceId: cameraId },
        meta,
      })
    } else {
      this.#deps.logger.debug('camera-sensors: camera motion counted', {
        tags: { deviceId: cameraId },
        meta,
      })
    }
  }

  /** The ready Confirm sensors active right now — who confirmed the camera (C10, review L4). */
  #activeConfirms(cameraId: number, agg: CameraAggregate): readonly number[] {
    const now = this.#deps.now()
    const windowMs = this.#windowMs(cameraId)
    const maxHoldMs = this.#deps.maxHoldMsFor(cameraId)
    return [...agg.inputs.values()]
      .filter((i) => i.mode === 'confirm' && i.ready)
      .filter((i) => sensorActive(this.#sensorState(i), now, windowMs, maxHoldMs))
      .map((i) => i.deviceId)
  }

  #emitTrue(
    cameraId: number,
    agg: CameraAggregate,
    timestamp: number,
    kind: EmitKind,
    regions?: MotionRegions,
  ): void {
    agg.lastEffectiveTrueAt = this.#deps.now()
    if (this.#emit(cameraId, true, timestamp, agg.firstTrigger ?? CAMERA_TRIGGER, kind, regions)) {
      agg.owesFalse = true
    }
  }

  /** A false goes out only when an input's own false (or a removal, or a stuck release) leaves no motion (C8). */
  #settle(
    cameraId: number,
    agg: CameraAggregate,
    timestamp: number,
    verdict: EffectiveMotion = this.#evaluate(cameraId, agg),
  ): void {
    if (verdict.high) {
      if (this.#isHigh(cameraId, agg) && !sensorHeld(verdict) && cameraCounts(verdict)) {
        this.#deps.logger.info(
          "camera-sensors: sensors quiet — false held back, the camera's own motion is still high",
          { tags: { deviceId: cameraId }, meta: { triggeredBy: agg.firstTrigger } },
        )
      }
      return
    }
    // An owed `false` goes out even after the level expired (H1); an expired level owed nothing.
    if (agg.owesFalse || this.#isHigh(cameraId, agg)) this.#close(cameraId, agg, timestamp)
  }

  #close(cameraId: number, agg: CameraAggregate, timestamp: number): void {
    this.#clearTimer(agg)
    const trigger = agg.firstTrigger ?? CAMERA_TRIGGER
    agg.firstTrigger = null
    agg.lastEffectiveTrueAt = null
    if (agg.owesFalse) this.#emit(cameraId, false, timestamp, trigger)
    agg.owesFalse = false
  }

  #sensorRise(cameraId: number, sensorId: number, capName: string, at: number): void {
    const agg = this.#cameras.get(cameraId)
    if (agg === undefined) return
    agg.stuckSaid.delete(sensorId)
    const verdict = this.#evaluate(cameraId, agg)
    if (!verdict.high) {
      this.#deps.logger.debug('camera-sensors: sensor active — waiting for the camera', {
        tags: { deviceId: cameraId },
        meta: { sourceDeviceId: sensorId, capName, mode: agg.inputs.get(sensorId)?.mode },
      })
      return
    }
    if (!this.#isHigh(cameraId, agg)) {
      this.#open(cameraId, agg, { kind: 'sensor', deviceId: sensorId }, verdict, {
        sourceDeviceId: sensorId,
        capName,
      })
    }
    this.#emitTrue(cameraId, agg, at, 'edge')
    if (agg.timer === null && sensorHeld(verdict)) this.#arm(cameraId, agg)
  }

  #arm(cameraId: number, agg: CameraAggregate): void {
    const timer = setInterval(() => {
      const current = this.#cameras.get(cameraId)
      if (current === undefined || !this.#isHigh(cameraId, current)) {
        this.#clearTimer(current ?? agg)
        return
      }
      const verdict = this.#evaluate(cameraId, current)
      this.#sayStuck(cameraId, current, verdict)
      if (sensorHeld(verdict)) {
        this.#emitTrue(cameraId, current, this.#deps.now(), 'tick')
        return
      }
      this.#clearTimer(current)
      if (!verdict.high) this.#close(cameraId, current, this.#deps.now())
    }, this.#deps.sustainMsFor(cameraId))
    timer.unref?.()
    agg.timer = timer
  }

  #sayStuck(cameraId: number, agg: CameraAggregate, verdict: EffectiveMotion): void {
    const now = this.#deps.now()
    const maxHoldMs = this.#deps.maxHoldMsFor(cameraId)
    for (const input of agg.inputs.values()) {
      const state = this.#sensorState(input)
      if (!state.high || state.lastRiseAt === null || now - state.lastRiseAt < maxHoldMs) continue
      if (agg.stuckSaid.has(input.deviceId)) continue
      agg.stuckSaid.add(input.deviceId)
      this.#deps.logger.warn('camera-sensors: sensor high too long — sustain stopped', {
        tags: { deviceId: cameraId },
        meta: {
          reason: 'sensor-stuck-high',
          sourceDeviceId: input.deviceId,
          sinceLastRiseMs: now - state.lastRiseAt,
          maxHoldMs,
          ...(verdict.high ? { falseWithheld: true } : {}),
        },
      })
    }
  }

  #sayDropped(cameraId: number, agg: CameraAggregate, verdict: EffectiveMotion): void {
    agg.dropped += 1
    if (agg.dropped !== 1 && agg.dropped % DROP_SAMPLE_EVERY !== 0) return
    this.#deps.logger.info('camera-sensors: camera motion not counted', {
      tags: { deviceId: cameraId },
      meta: {
        reason: verdict.cameraDropped,
        cameraMotion: verdict.cameraMotion,
        droppedCount: agg.dropped,
      },
    })
  }

  /** Verbatim, named as the camera — unconditional (C7). The level and the owed `false` are kept (H2). */
  #passThrough(edge: CameraMotionEdge): void {
    this.#cameraLevels.set(edge.deviceId, { detected: edge.detected, atMs: this.#deps.now() })
    if (edge.detected) this.#passOwed.add(edge.deviceId)
    else this.#passOwed.delete(edge.deviceId)
    this.#deps.emitMotion({
      deviceId: edge.deviceId,
      detected: edge.detected,
      timestamp: edge.timestamp,
      triggeredBy: CAMERA_TRIGGER,
      ...(edge.regions === undefined ? {} : { regions: edge.regions }),
    })
  }

  #clearTimer(agg: CameraAggregate): void {
    if (agg.timer === null) return
    clearInterval(agg.timer)
    agg.timer = null
  }

  #sayNotForwarded(
    cameras: ReadonlySet<number>,
    sensorId: number,
    capName: string,
    reason: 'baseline-seeded-stale-active' | 'missing-timestamp',
  ): void {
    for (const cameraId of cameras) {
      this.#deps.logger.info('camera-sensors: sensor rise not forwarded', {
        tags: { deviceId: cameraId },
        meta: { sourceDeviceId: sensorId, capName, reason },
      })
    }
  }

  /**
   * Emit, unless the camera does not carry `onboard` (R6: attaching a sensor
   * does not add it). A rise that reaches nothing is said at `info`; a sustain
   * tick or a fall at `debug` — the rise of that episode already said it.
   */
  #emit(
    cameraId: number,
    detected: boolean,
    timestamp: number,
    triggeredBy: MotionTriggeredBy,
    kind: EmitKind = 'edge',
    regions?: MotionRegions,
  ): boolean {
    const sources = this.#deps.motionSourcesFor(cameraId)
    const notForwarded = notForwardedReason(sources)
    if (notForwarded !== null) {
      const line = 'camera-sensors: trigger not forwarded — the camera does not list `onboard`'
      const extras = {
        tags: { deviceId: cameraId },
        meta: {
          detected,
          reason: notForwarded,
          sources: sources ?? 'no-active-detection',
          triggeredBy,
        },
      }
      if (detected && kind === 'edge') this.#deps.logger.info(line, extras)
      else this.#deps.logger.debug(line, extras)
      return false
    }
    this.#deps.emitMotion({
      deviceId: cameraId,
      detected,
      timestamp,
      triggeredBy,
      ...(regions === undefined ? {} : { regions }),
    })
    return true
  }
}
