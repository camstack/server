/**
 * The camera's `motion` runtime slice (D696): only the orchestrator writes it,
 * with the camera's EFFECTIVE motion, through `deviceState.setCapSlice`. A
 * provider never writes it, and the runner's phase machine never writes it.
 * The slice means MOTION: `detected` plus the `lastDetectedAt` of the last
 * effective rise. It is not "a session is attached".
 *
 * ## Which input feeds which camera
 *
 * Every input is a `MotionOnMotionChanged` the orchestrator already receives:
 * - `onboard` with `triggeredBy`: the camera-sensors bridge, for a SPLIT
 *   camera (its effective output, the combining rule applied);
 * - `onboard` without it: an UNSPLIT emitter (camera-grid, a rolled-back
 *   provider), whose own event is that camera's motion (C13);
 * - `analyzer`: the runner's analyzer transitions;
 * - `device-activity`: the device's own working level (D392).
 *
 * The camera's `motionSources` decides which count, under D475's rule: a
 * sensor-owned camera never counts the analyzer. A camera with no active
 * detection config counts `onboard` and `device-activity`, never the analyzer
 * (no analyzer runs for it). The class each camera is fed by is said once per
 * change (`camera motion slice: input`).
 *
 * ## The level
 *
 * Per source: high from a counted `true` until that source's own `false`, or
 * until one window after its last `true`. The window is the camera's
 * `motionCooldownMs` floored at two sustain ticks, the same window the bridge
 * holds an effective level for. The camera is ON while any counted source is
 * high. A source that never sends a clear (Reolink, Wyze) therefore falls one
 * window after its last push and cannot leave the slice stuck ON. That was the
 * runner phase machine's rule for every source; an explicit `false` now also
 * ends the level, as the effective event already does for every consumer.
 *
 * ## Writing
 *
 * Every effective EDGE is snapshotted when it happens and written in order, per
 * camera, so a short episode is not lost behind the hub round trip.
 * `lastDetectedAt` moves only on an effective rise. A write that fails is said,
 * and the next change writes again (D391).
 *
 * ## The writer gates and the takeover
 *
 * Nothing is written while the runner gate is closed (`MotionSliceWriterGate`:
 * a runner older than D696 still writes the slice), and nothing is written to
 * a camera the PROVIDER gate keeps closed (`ProviderSliceGate`: that camera's
 * own provider may still write it — D696 amended 2026-10-02), so one slice
 * never has two writers. A camera whose provider gate opens later is taken
 * over then, alone, exactly as below. The level is tracked meanwhile. When the gate opens (this
 * orchestrator's boot or respawn, or the runner handing over), every camera is
 * re-published:
 * - a camera whose level this instance knows gets that level at once;
 * - any other camera gets a GRACE WINDOW of one window. A motion event inside
 *   it continues the episode with no OFF blip. If none comes, the camera's
 *   slice is read: a slice still ON is published OFF, keeping its
 *   `lastDetectedAt`.
 *
 * The bound is the level's own rule. Any live episode re-asserts within one
 * window: every heartbeat source does, and the bridge's sustain ticks do. So
 * when nothing came, the level the previous writer held has expired by this
 * same rule. A clear this instance never saw rise reaches a slice still ON the
 * same way, through the read. An unreadable read changes nothing and is said
 * (D49, D393): a slice is never assumed OFF.
 */
import {
  COMPOSER_ADDON_ID,
  cameraOwnsMotionViaSensor,
  errMsg,
  type IScopedLogger,
  MOTION_CLOSE_AFTER_MS,
  type MotionSource,
  type MotionSources,
  type MotionStatus,
} from '@camstack/types'
import type { CameraIdsRead } from './controller.js'

/** One `MotionOnMotionChanged`, as the slice reads it. */
export interface MotionSliceEdge {
  readonly deviceId: number
  readonly detected: boolean
  readonly timestamp: number
  readonly source: MotionSource
  /** `onboard` from the camera-sensors bridge (`triggeredBy` present); false = an unsplit emitter. */
  readonly viaBridge: boolean
}

/** A read of the camera's slice from the hub. */
export type MotionSliceRead =
  | { readonly kind: 'answered'; readonly slice: Readonly<Record<string, unknown>> | null }
  | { readonly kind: 'unreadable'; readonly error: string }

export interface CameraMotionSliceDeps {
  readonly logger: IScopedLogger
  /** `deviceState.setCapSlice({ deviceId, capName: 'motion', slice })`. */
  readonly writeSlice: (deviceId: number, slice: MotionStatus) => Promise<void>
  readonly readSlice: (deviceId: number) => Promise<MotionSliceRead>
  /** Every camera, for the takeover re-publish. */
  readonly listCameraIds: () => Promise<CameraIdsRead>
  /** The camera's active `motionSources`; `null` = no active detection config. */
  readonly motionSourcesFor: (deviceId: number) => MotionSources | null
  /** How long a source that never clears holds its `true`, and the takeover's grace window. */
  readonly windowMsFor: (deviceId: number) => number
  /** The camera's `maxSessionHoldMs`: how long a source that sends its own clear is held without one. */
  readonly maxHoldMsFor: (deviceId: number) => number
  readonly now: () => number
  /** A motion edge arrived for a camera this instance may not write: let the gates look again. */
  readonly onEdgeWhileClosed: () => void
  /** The provider gate: may this camera's slice be written (its provider does not write it)? */
  readonly isCameraOpen: (deviceId: number) => boolean
}

/** One camera row of the fleet listing: what the takeover needs to know. */
export interface SliceCameraRow {
  readonly id: number
  readonly addonId: string
}

/**
 * The cameras whose `motion` slice is the orchestrator's to re-publish on a
 * takeover. A device the COMPOSER owns is left out: a composed camera's
 * slices are the composer's own (it seeds and patches them), and it emits no
 * motion event, so a grace-window OFF over it would be a second writer.
 */
export function camerasTheSliceOwns(rows: readonly SliceCameraRow[]): readonly number[] {
  return rows.filter((r) => r.addonId !== COMPOSER_ADDON_ID).map((r) => r.id)
}

/** Why a write happens (said on its line). */
type WriteReason = 'edge' | 'expired' | 'takeover' | 'grace-expired'

/** The input classes a camera is fed by (the `input` line). */
type InputKind = 'onboard:bridge' | 'onboard:unsplit' | 'analyzer' | 'device-activity'

interface SourceLevel {
  high: boolean
  timer: NodeJS.Timeout | null
}

/** What this instance last decided the slice is; `unknown` = it has not, or it cannot vouch for it. */
type Intended =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly detected: boolean; readonly lastDetectedAt: number | null }

interface CameraSliceState {
  readonly levels: Map<MotionSource, SourceLevel>
  onboardPath: 'bridge' | 'unsplit' | null
  /** The last effective level computed; null = no counted input known yet. */
  effective: boolean | null
  /** The last effective rise's timestamp: the next `true` write's `lastDetectedAt` candidate. */
  riseAt: number | null
  /** The `lastDetectedAt` last written (or read back): a write never goes below it (review F8). */
  stamp: number | null
  intended: Intended
  graceExpired: boolean
  graceTimer: NodeJS.Timeout | null
  /** When the takeover's grace window ends, kept across gate closures (review F7). */
  graceDeadline: number | null
  /** The `input` line last said. */
  said: string | null
  chain: Promise<void>
}

const UNKNOWN: Intended = { kind: 'unknown' }

/** Does `source` count toward this camera's motion? */
function counts(source: MotionSource, sources: MotionSources | null): boolean {
  if (sources === null) return source !== 'analyzer'
  if (!sources.includes(source)) return false
  return !(source === 'analyzer' && cameraOwnsMotionViaSensor(sources))
}

/**
 * Does this source send its OWN clear (review F3)? Such a source is held until
 * that clear, bounded by `maxSessionHoldMs`; any other falls one window after
 * its last `true`.
 * - the analyzer: emits only transitions, `true` then `false` — held;
 * - an UNSPLIT onboard emitter (camera-grid): edges only, with a `false` — held;
 * - the bridge's events: a heartbeat stream (the camera's own pushes, the
 *   sustain ticks) for a source that may never clear (Reolink, Wyze) — window;
 * - device activity: sustain ticks plus a `false` — window (the ticks keep it).
 */
function sendsOwnClear(edge: MotionSliceEdge): boolean {
  if (edge.source === 'analyzer') return true
  return edge.source === 'onboard' && !edge.viaBridge
}

function stampOf(slice: Readonly<Record<string, unknown>> | null): number | null {
  const value = slice?.['lastDetectedAt']
  return typeof value === 'number' ? value : null
}

export class CameraMotionSlice {
  readonly #deps: CameraMotionSliceDeps
  readonly #cameras: Map<number, CameraSliceState> = new Map()
  #open = false
  #stopped = false
  #takeover: Promise<void> = Promise.resolve()

  constructor(deps: CameraMotionSliceDeps) {
    this.#deps = deps
  }

  /** A `MotionOnMotionChanged` for a camera. Memory only; the write is queued. */
  onMotion(edge: MotionSliceEdge): void {
    if (this.#stopped) return
    const st = this.#state(edge.deviceId)
    if (edge.source === 'onboard') st.onboardPath = edge.viaBridge ? 'bridge' : 'unsplit'
    const level = st.levels.get(edge.source) ?? { high: false, timer: null }
    st.levels.set(edge.source, level)
    if (level.timer !== null) clearTimeout(level.timer)
    level.timer = null
    level.high = edge.detected
    if (edge.detected) {
      const held = sendsOwnClear(edge)
      const holdMs = held
        ? this.#deps.maxHoldMsFor(edge.deviceId)
        : this.#deps.windowMsFor(edge.deviceId)
      const timer = setTimeout(() => {
        level.timer = null
        level.high = false
        if (held) {
          this.#deps.logger.warn(
            'camera motion slice: source held past maxSessionHoldMs without its own clear — released',
            {
              tags: { deviceId: edge.deviceId },
              meta: { source: edge.source, viaBridge: edge.viaBridge, maxHoldMs: holdMs },
            },
          )
        }
        this.#changed(edge.deviceId, this.#deps.now(), 'expired')
      }, holdMs)
      timer.unref?.()
      level.timer = timer
    }
    this.#sayInputs(edge.deviceId, st)
    this.#changed(edge.deviceId, edge.timestamp, 'edge')
    if (!this.#writable(edge.deviceId)) this.#deps.onEdgeWhileClosed()
  }

  /**
   * The provider gate moved for these cameras. One that opened is taken over
   * now (with the runner gate open); one that closed is no longer vouched for.
   */
  camerasChanged(deviceIds: readonly number[]): Promise<void> {
    if (this.#stopped) return this.#takeover
    for (const deviceId of deviceIds) {
      const st = this.#state(deviceId)
      st.intended = UNKNOWN
      if (!this.#deps.isCameraOpen(deviceId)) {
        // The timer goes; its DEADLINE stays, as for a runner-gate closure (F7).
        this.#clearGraceTimer(st)
        continue
      }
      if (this.#open) this.#takeOver(deviceId, st)
    }
    return this.#takeover
  }

  /** The writer gate moved. Opening re-publishes every camera (see the header). */
  setWriterOpen(open: boolean): Promise<void> {
    if (this.#stopped || open === this.#open) return this.#takeover
    this.#open = open
    if (!open) {
      for (const st of this.#cameras.values()) {
        st.intended = UNKNOWN
        // The timer goes; its DEADLINE stays, so a reopening re-arms only the remainder (F7).
        this.#clearGraceTimer(st)
      }
      this.#deps.logger.info(
        'camera motion slice: not writing — a runner node still writes the slice or has not answered',
      )
      return this.#takeover
    }
    this.#deps.logger.info('camera motion slice: writing — taking over every camera')
    this.#takeover = this.#republishAll()
    return this.#takeover
  }

  /** Test and teardown seam: resolves when no takeover or write is pending. */
  async idle(): Promise<void> {
    await this.#takeover
    for (;;) {
      const chains = [...this.#cameras.values()].map((st) => st.chain)
      await Promise.all(chains)
      if ([...this.#cameras.values()].every((st, i) => st.chain === chains[i])) return
    }
  }

  stop(): void {
    this.#stopped = true
    for (const st of this.#cameras.values()) {
      for (const level of st.levels.values()) if (level.timer !== null) clearTimeout(level.timer)
      this.#clearGrace(st)
    }
    this.#cameras.clear()
  }

  #state(deviceId: number): CameraSliceState {
    const existing = this.#cameras.get(deviceId)
    if (existing !== undefined) return existing
    const st: CameraSliceState = {
      levels: new Map(),
      onboardPath: null,
      effective: null,
      riseAt: null,
      stamp: null,
      intended: UNKNOWN,
      graceExpired: false,
      graceTimer: null,
      graceDeadline: null,
      said: null,
      chain: Promise.resolve(),
    }
    this.#cameras.set(deviceId, st)
    return st
  }

  #effective(deviceId: number, st: CameraSliceState): boolean | null {
    const sources = this.#deps.motionSourcesFor(deviceId)
    let known = false
    for (const [source, level] of st.levels) {
      if (!counts(source, sources)) continue
      if (level.high) return true
      known = true
    }
    return known || st.graceExpired ? false : null
  }

  /** The level may have moved: track the rise, and queue the write the gate allows. */
  #changed(deviceId: number, timestamp: number, reason: WriteReason): void {
    const st = this.#state(deviceId)
    const effective = this.#effective(deviceId, st)
    if (effective === null) return
    if (effective && st.effective !== true) st.riseAt = timestamp
    st.effective = effective
    this.#clearGrace(st)
    if (!this.#writable(deviceId)) return
    const intended = st.intended
    if (effective) {
      if (intended.kind === 'known' && intended.detected) return
      const rise = st.riseAt ?? this.#deps.now()
      const overUnknown = intended.kind === 'unknown'
      st.intended = { kind: 'known', detected: true, lastDetectedAt: rise }
      this.#queue(deviceId, st, () => this.#writeRise(deviceId, st, rise, overUnknown, reason))
      return
    }
    if (intended.kind === 'known') {
      if (!intended.detected) return
      st.intended = { kind: 'known', detected: false, lastDetectedAt: intended.lastDetectedAt }
      // The stamp is read when the job RUNS: the rise queued before it has set it (F8).
      this.#queue(deviceId, st, () =>
        this.#write(
          deviceId,
          st,
          {
            detected: false,
            lastDetectedAt: st.stamp ?? intended.lastDetectedAt,
            autoClearAfterMs: null,
          },
          reason,
        ),
      )
      return
    }
    // OFF over a slice this instance cannot vouch for (a respawn, a takeover):
    // read it, and write only when it is still ON (keeping its stamp).
    st.intended = { kind: 'known', detected: false, lastDetectedAt: st.riseAt }
    this.#queue(deviceId, st, () => this.#clearIfOn(deviceId, st, reason))
  }

  #queue(deviceId: number, st: CameraSliceState, job: () => Promise<void>): void {
    st.chain = st.chain.then(job).catch((err: unknown) => {
      this.#deps.logger.error('camera motion slice: write job failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    })
  }

  /**
   * A rise. `lastDetectedAt` never moves backwards (review F8): it is the max of
   * this rise, the stamp last written and, over a slice this instance cannot vouch
   * for (a takeover), the slice's own stamp — an old runner may have written a
   * later one. An unreadable slice costs only that last comparison.
   */
  async #writeRise(
    deviceId: number,
    st: CameraSliceState,
    rise: number,
    overUnknown: boolean,
    reason: WriteReason,
  ): Promise<void> {
    let stamp = Math.max(rise, st.stamp ?? rise)
    if (overUnknown) {
      const read = await this.#deps.readSlice(deviceId)
      const prior = read.kind === 'answered' ? stampOf(read.slice) : null
      if (prior !== null) stamp = Math.max(stamp, prior)
    }
    // A gate may have closed while the read was in flight (WorkerOnline on a
    // provider restart): do not land a setCapSlice the gate no longer allows.
    if (!this.#writable(deviceId)) return
    await this.#write(
      deviceId,
      st,
      { detected: true, lastDetectedAt: stamp, autoClearAfterMs: MOTION_CLOSE_AFTER_MS },
      reason,
    )
  }

  async #clearIfOn(deviceId: number, st: CameraSliceState, reason: WriteReason): Promise<void> {
    const read = await this.#deps.readSlice(deviceId)
    if (read.kind === 'unreadable') {
      st.intended = UNKNOWN
      this.#deps.logger.warn(
        'camera motion slice: slice unreadable — not re-published, it stands as it is',
        { tags: { deviceId }, meta: { reason, error: read.error } },
      )
      return
    }
    const readStamp = stampOf(read.slice)
    if (readStamp !== null) st.stamp = Math.max(readStamp, st.stamp ?? readStamp)
    if (read.slice?.['detected'] !== true) {
      this.#deps.logger.debug('camera motion slice: already off — nothing to publish', {
        tags: { deviceId },
        meta: { reason },
      })
      return
    }
    if (!this.#writable(deviceId)) return
    await this.#write(
      deviceId,
      st,
      { detected: false, lastDetectedAt: stampOf(read.slice), autoClearAfterMs: null },
      reason,
    )
  }

  async #write(
    deviceId: number,
    st: CameraSliceState,
    slice: MotionStatus,
    reason: WriteReason,
  ): Promise<void> {
    if (!this.#writable(deviceId)) return
    try {
      await this.#deps.writeSlice(deviceId, slice)
    } catch (err: unknown) {
      st.intended = UNKNOWN
      this.#deps.logger.warn('camera motion slice: write failed — the next change writes again', {
        tags: { deviceId },
        meta: { detected: slice.detected, reason, error: errMsg(err) },
      })
      return
    }
    if (slice.lastDetectedAt !== null) {
      st.stamp = Math.max(slice.lastDetectedAt, st.stamp ?? slice.lastDetectedAt)
    }
    if (reason === 'takeover' || reason === 'grace-expired') {
      this.#deps.logger.info('camera motion slice: re-published', {
        tags: { deviceId },
        meta: {
          reason,
          detected: slice.detected,
          lastDetectedAt: slice.lastDetectedAt,
          ...(reason === 'grace-expired' ? { graceMs: this.#graceMsFor(deviceId) } : {}),
        },
      })
      return
    }
    this.#deps.logger.debug('camera motion slice: written', {
      tags: { deviceId },
      meta: { reason, detected: slice.detected, lastDetectedAt: slice.lastDetectedAt },
    })
  }

  async #republishAll(): Promise<void> {
    const listed = await this.#deps
      .listCameraIds()
      .catch((err: unknown): CameraIdsRead => ({ kind: 'unreadable', error: errMsg(err) }))
    if (!this.#open || this.#stopped) return
    if (listed.kind === 'unreadable') {
      this.#deps.logger.warn(
        'camera motion slice: camera list unreadable — only cameras with motion since boot are re-published',
        { meta: { error: listed.error } },
      )
    }
    const ids = new Set([...(listed.kind === 'ids' ? listed.ids : []), ...this.#cameras.keys()])
    for (const deviceId of ids) {
      const st = this.#state(deviceId)
      st.intended = UNKNOWN
      // A camera whose provider may still write it is taken over when its
      // provider gate opens (`camerasChanged`), never here.
      if (!this.#deps.isCameraOpen(deviceId)) continue
      this.#takeOver(deviceId, st)
    }
  }

  /** Re-publish one camera: its known level at once, else a grace window. */
  #takeOver(deviceId: number, st: CameraSliceState): void {
    if (this.#effective(deviceId, st) !== null) {
      this.#changed(deviceId, st.riseAt ?? this.#deps.now(), 'takeover')
      return
    }
    this.#armGrace(deviceId, st)
  }

  /** Both gates allow writing this camera's slice. */
  #writable(deviceId: number): boolean {
    return this.#open && !this.#stopped && this.#deps.isCameraOpen(deviceId)
  }

  /**
   * The grace window: one window, or `maxSessionHoldMs` for a camera whose motion
   * is the analyzer's — a source that sends its own clear is held until it (F3),
   * so a live analyzer episode must not be clipped by a takeover either. Its
   * DEADLINE is set once and kept across gate closures; a reopening re-arms only
   * the remainder (review F7).
   */
  #armGrace(deviceId: number, st: CameraSliceState): void {
    if (st.graceExpired) {
      this.#changed(deviceId, this.#deps.now(), 'grace-expired')
      return
    }
    this.#clearGraceTimer(st)
    const now = this.#deps.now()
    st.graceDeadline ??= now + this.#graceMsFor(deviceId)
    const timer = setTimeout(
      () => {
        st.graceTimer = null
        st.graceExpired = true
        this.#changed(deviceId, this.#deps.now(), 'grace-expired')
      },
      Math.max(0, st.graceDeadline - now),
    )
    timer.unref?.()
    st.graceTimer = timer
  }

  #graceMsFor(deviceId: number): number {
    const window = this.#deps.windowMsFor(deviceId)
    const sources = this.#deps.motionSourcesFor(deviceId)
    return sources !== null && counts('analyzer', sources)
      ? Math.max(window, this.#deps.maxHoldMsFor(deviceId))
      : window
  }

  #clearGraceTimer(st: CameraSliceState): void {
    if (st.graceTimer === null) return
    clearTimeout(st.graceTimer)
    st.graceTimer = null
  }

  /** A counted edge settled the camera: no grace needed any more. */
  #clearGrace(st: CameraSliceState): void {
    this.#clearGraceTimer(st)
    st.graceDeadline = null
  }

  #sayInputs(deviceId: number, st: CameraSliceState): void {
    const sources = this.#deps.motionSourcesFor(deviceId)
    const inputs: InputKind[] = []
    const ignored: MotionSource[] = []
    for (const source of st.levels.keys()) {
      if (!counts(source, sources)) {
        ignored.push(source)
        continue
      }
      if (source === 'onboard')
        inputs.push(st.onboardPath === 'unsplit' ? 'onboard:unsplit' : 'onboard:bridge')
      else inputs.push(source)
    }
    inputs.sort()
    ignored.sort()
    const signature = JSON.stringify({ inputs, ignored })
    if (signature === st.said) return
    st.said = signature
    this.#deps.logger.info('camera motion slice: input', {
      tags: { deviceId },
      meta: { inputs, ignored, motionSources: sources ?? 'no-active-detection' },
    })
  }
}
