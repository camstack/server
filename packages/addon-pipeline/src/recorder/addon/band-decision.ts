/**
 * Pure glue between a device's `RecordingConfig` and the v2 band engine: decide
 * whether recording should currently be running, and which finalized segments
 * an `events` band retains.
 *
 * The decision is enabled AND the band active at `now` (per the v2
 * `activeBandAt`/`bandActiveAt`) demands recording: a `continuous` band always
 * demands; an `events` band demands only within `postBufferSec` of a qualifying
 * trigger (B3). No bands / disabled => not recording.
 *
 * `preBufferSec` is retroactive — it is NOT a live-demand input; it retains
 * already-recorded segments BEFORE a trigger at keep/discard time
 * ({@link segmentRetainedForEvents}). This mirrors the old recorder's proven
 * policy split (start-on-trigger live gate + retroactive pre-buffer keep).
 *
 * Kept pure (clock + trigger state injected) so the attach/detach decision is
 * unit-testable without ffmpeg, the broker, the event bus, or a real wall clock.
 */
import { PREBUFFER_MAX_MS } from '../../stream-broker/prebuffer.js'
import { DEFAULT_EVENTS_BAND_BUFFER_SEC } from '@camstack/types'
import type {
  FirstLevelMacroClass,
  RecordingBand,
  RecordingBandAudio,
  RecordingConfig,
} from '@camstack/types'
import { activeBandAt } from '../band-engine.js'

/**
 * A band the DECISION reads — an authored {@link RecordingBand} plus the one
 * fact no operator authors: that this band exists because the DEVICE decides
 * when to record (`RecordingConfig.deviceDecision`, D380).
 *
 * It is an extra optional field and nothing else, so every authored band is an
 * `EffectiveBand` already and no caller had to change. The flag can only be set
 * by {@link effectiveBands} on {@link DEVICE_DECISION_BAND}: it is deliberately
 * NOT on `RecordingBandSchema`, because it is not on the wire — D371 put the
 * signal INSIDE a band as `triggers.deviceSignal` and that was the mistake this
 * type exists to undo. A band is an HOUR; this one has none to program.
 */
export interface EffectiveBand extends RecordingBand {
  /** True only on {@link DEVICE_DECISION_BAND} — the camera's own
   *  `recording-signal` level is this band's single trigger source. */
  readonly deviceSignal?: true
}

/**
 * THE band a `deviceDecision` config decides through: always on (every day,
 * `start === end` — the band engine's always-on shape), `events`, and listening
 * to exactly one source, the camera's own level.
 *
 * Its buffers are the canonical pad ({@link DEFAULT_EVENTS_BAND_BUFFER_SEC}),
 * not per-camera knobs: this mode's whole contract with the operator is ONE
 * flag. The pad only ever retains footage around an episode the device itself
 * delimited, so there is nothing here for an operator to tune.
 */
export const DEVICE_DECISION_BAND: EffectiveBand = Object.freeze({
  days: [],
  start: '00:00',
  end: '00:00',
  mode: 'events',
  deviceSignal: true,
  postBufferSec: DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec,
})

/**
 * THE bands the recorder decides on for a config — the ONE place
 * `config.bands` is turned into what the gates read.
 *
 * `deviceDecision` resolves to {@link DEVICE_DECISION_BAND} and to nothing
 * else; every other config is its own authored bands, byte for byte. Because
 * the schema makes the two exclusive, this is a choice and never a merge.
 */
export function effectiveBands(config: RecordingConfig): readonly EffectiveBand[] {
  if (config.deviceDecision === true) return [DEVICE_DECISION_BAND]
  return config.bands ?? []
}

/** A band's resolved trigger buffers, in milliseconds. */
export interface BandBufferMs {
  readonly preMs: number
  readonly postMs: number
}

/**
 * THE one place a band's buffers are read.
 *
 * `postMs` is the LIVE demand window and stays a per-band setting: it decides
 * how long a writer keeps running, which is a policy about this camera at this
 * hour. An ABSENT field takes {@link DEFAULT_EVENTS_BAND_BUFFER_SEC}; an
 * explicit value — including `0` — is honoured verbatim, because both callers
 * used to inline `?? 0` and read "the operator omitted the field" as "the
 * operator asked for a zero-length window", which for the live gate is not a
 * policy but an impossibility. Two cameras sat in exactly that state.
 *
 * `preMs` is NOT a setting any more (D381). It is the retroactive KEEP bound —
 * which already-written segments survive a trigger — and its only correct
 * value was ever "at least as wide as the widest history the broker can hand
 * the writer". So it IS that ceiling, read from the one place that defines it:
 * a keep gate can no longer be configured narrower than the media it is
 * supposed to keep, which is the disagreement D191 was written against and
 * which a per-band number could only ever warn about.
 */
export function resolveBandBufferMs(band: EffectiveBand): BandBufferMs {
  return {
    preMs: PREBUFFER_MAX_MS,
    postMs: (band.postBufferSec ?? DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec) * 1000,
  }
}

/**
 * Can this band EVER open a live recording window? False for an `events` band
 * whose resolved post-buffer is zero (only reachable by authoring an explicit
 * `0`) or which lists no trigger at all: both are "enabled, and records nothing,
 * forever". The recorder warns on it rather than dropping the device silently.
 */
export function eventsBandCanEverDemand(band: EffectiveBand): boolean {
  if (band.mode !== 'events') return true
  return bandTriggerSources(band).length > 0 && resolveBandBufferMs(band).postMs > 0
}

/** The `kind`s that a trigger source can have. */
export type TriggerSourceKind = 'motion' | 'audio' | 'object' | 'sensor' | 'signal'

/**
 * WHICH signal opened a window.
 *
 * Discriminated union and not a string: two sources are PARAMETRIC — one
 * window per macro class, one per source device — and a `${kind}:${param}`
 * typed `string` would let `'object:persno'` compile.
 */
export type TriggerSource =
  | { readonly kind: 'motion' }
  | { readonly kind: 'audio' }
  | { readonly kind: 'object'; readonly macroClass: FirstLevelMacroClass }
  | { readonly kind: 'sensor'; readonly sourceDeviceId: number }
  /** The camera itself, through its `recording-signal` cap — a LEVEL
   *  (see {@link holdTrigger}), not an edge with a timestamp. */
  | { readonly kind: 'signal' }

/**
 * The key under which a source keeps its windows. It is also the string
 * that appears in the logs — four sources opening the same window without
 * saying who did it make it impossible to answer "why does this camera
 * record so much" — so it is readable by design.
 */
export function triggerKey(source: TriggerSource): string {
  switch (source.kind) {
    case 'motion':
      return 'motion'
    case 'audio':
      return 'audio'
    case 'object':
      return `object:${source.macroClass}`
    case 'sensor':
      return `sensor:${source.sourceDeviceId}`
    case 'signal':
      return 'signal'
  }
}

/**
 * Keys of `RecordingTriggers` authorized by the UI that NO `onTrigger`
 * feeds yet.
 *
 * Empty today — not removed. `audioThresholdDbfs` was in it from 2026-08-26
 * until this same track wired it (see
 * `RecordingController.onAudioLevel`, `recording-controller.ts`, fed
 * by the subscription to `EventCategory.PipelineAudioInferenceResult` in
 * `recorder/addon/index.ts`): it was authorized by the UI, read by four pure
 * functions of this file, and fed by nobody — a band that
 * listened to audio ONLY never recorded, forever, without a line (D62).
 *
 * `scripts/check-recording-trigger-fed.ts` reads this set: a key
 * here is a DATED exception justified in the comment, not a shortcut. The
 * two keys that Track A/B will add (`objectClasses`,
 * `sensorDeviceIds`) pass through here exactly as this one did, if
 * their feed is not yet written when the schema declares it.
 */
export const UNFED_TRIGGER_KEYS: ReadonlySet<string> = new Set()

/**
 * Which {@link TriggerSourceKind} feeds each key of
 * `RecordingTriggers`. Read by `scripts/check-recording-trigger-fed.ts`: it is the
 * bridge between the wire shape (the schema) and the internal source that
 * {@link bandTriggerSources} produce.
 */
export const TRIGGER_KEY_TO_SOURCE_KIND: Readonly<Record<string, TriggerSourceKind>> = {
  motion: 'motion',
  audioThresholdDbfs: 'audio',
  objectClasses: 'object',
  sensorDeviceIds: 'sensor',
  // NOT a `RecordingTriggers` key: `RecordingConfig.deviceDecision`, the
  // whole-config MODE that replaced `triggers.deviceSignal` on 2026-09-07
  // (D380). It is declared here so `check-recording-trigger-fed.ts` keeps
  // proving the `signal` source has a production feed — a mode is exactly as
  // able to be a dead knob as a trigger key was (D62).
  deviceDecision: 'signal',
}

/** The single source {@link DEVICE_DECISION_BAND} listens to, shared so the
 *  band never allocates a new one per call. */
const SIGNAL_SOURCES: readonly TriggerSource[] = Object.freeze([{ kind: 'signal' } as const])

/**
 * THE sources this band listens to — the only place where a band's `triggers`
 * become `TriggerSource[]`.
 *
 * Before there were FIVE copies of the same motion/audio if-ladder
 * (`eventsBandCanEverDemand`, `eventsBandDemanded`, `segmentRetainedForEvents`,
 * `segmentMissedByMs`, `eventsWindowCloseMs`), which with four sources
 * would have become five four-branch ladders. `RecordingController`
 * (`reportUnrecordable`, the durable reconciliation) reads the same list.
 *
 * A key in {@link UNFED_TRIGGER_KEYS} produces no sources: the band that
 * listens only to it "can never demand", and that is how the recorder
 * reports it instead of staying silent.
 */
export function bandTriggerSources(band: EffectiveBand): readonly TriggerSource[] {
  // The camera's own level. ONE source, unparameterized: the signal is the
  // camera's, so there is nothing to name — and it is the ONLY source of the
  // band the device decides through, which carries no triggers at all.
  if (band.deviceSignal === true) return SIGNAL_SOURCES
  const t = band.triggers
  if (t === undefined) return []
  const sources: TriggerSource[] = []
  if (t.motion === true) sources.push({ kind: 'motion' })
  if (t.audioThresholdDbfs !== undefined) sources.push({ kind: 'audio' })
  // One source PER CLASS, not one `object` bucket: a band listening for
  // `person` must not be opened by every passing car. The schema rejects an
  // empty array, so an absent key is the only way to not listen.
  for (const macroClass of t.objectClasses ?? []) sources.push({ kind: 'object', macroClass })
  // Same reason, one source PER SOURCE DEVICE: the band that names sensor 42
  // must not be opened by sensor 43. `MAX_SENSOR_TRIGGER_DEVICES` is what
  // bounds the resulting key count in `TriggerState`.
  for (const sourceDeviceId of t.sensorDeviceIds ?? []) {
    sources.push({ kind: 'sensor', sourceDeviceId })
  }
  return sources
}

/**
 * Does this audio window's level clear the ACTIVE band's configured
 * threshold?
 *
 * `PipelineAudioInferenceResultPayload.frame.level.dbfs`
 * (`packages/types/src/types/detection.ts:448`) and
 * `RecordingTriggers.audioThresholdDbfs` are the SAME unit and the SAME
 * scale — dBFS, 0 = full scale, more negative = quieter — produced by
 * `AudioAnalyzerProvider.analyseChunk` in `audio-analyzer/addons/analyzer/index.ts` (`20 * log10(rms)`). No conversion exists
 * between them because none is needed: the one other place in this repo that
 * compares the two values does the same bare `>=`
 * (`notification-center/audio-rule-matcher.ts:221`). Inventing a conversion
 * here would recreate the exact defect this track exists to close, only
 * harder to see because a wrong scale still fires occasionally.
 *
 * `band` must be the band ACTIVE AT the audio window's own timestamp — a
 * device can carry several bands with different thresholds (day/night), and
 * only one is ever "the" threshold at a given instant. The caller
 * (`RecordingController.onAudioLevel`) resolves it the same way
 * `postBufferMsFor` resolves the post-buffer.
 */
export function audioLevelQualifies(band: EffectiveBand | null, dbfs: number): boolean {
  const threshold = band?.triggers?.audioThresholdDbfs
  return threshold !== undefined && dbfs >= threshold
}

/**
 * ONE episode of qualifying triggers, merged: `firstMs` is when it opened,
 * `lastMs` the most recent trigger that extended it. A window's KEEP span is
 * `[firstMs - preBufferSec, lastMs + postBufferSec]`.
 *
 * Consecutive triggers merge into one window while they arrive within
 * `postBufferSec` of each other, because that is precisely the interval over
 * which the recorder never stopped: a trigger landing inside the open live
 * window did not start a new recording, it extended the running one, and the
 * footage in between is ONE episode.
 */
export interface TriggerWindow {
  readonly firstMs: number
  readonly lastMs: number
}

/**
 * Qualifying trigger HISTORY for a device, maintained by the controller from
 * the EventCapture marker stream. A timestamp only lands here once the trigger
 * qualifies (motion detected / audio over the band threshold) — the
 * qualification test stays upstream so THIS layer is pure timestamp comparison,
 * mirroring the old recorder's policy split.
 *
 * ## Why a LIST and not the last timestamp
 *
 * This was two scalars (`lastMotionMs` / `lastAudioMs`) until 2026-08-20, and
 * the keep gate compared each finalized segment against the LATEST trigger
 * only. A segment is finalized long after the media in it was captured
 * (measured p50 9.8 s: ffmpeg closes the file, the playlist is polled, the
 * successor's start corrects the duration), and under CONTINUOUS motion the
 * latest trigger keeps advancing the whole time. So the gate's pre-buffer test
 * `segEndMs < lastMotionMs - preMs` compared footage against a trigger that
 * fired AFTER it was recorded, and deleted the earlier part of the very episode
 * the recorder had been started for. With finalize lag ~= `preBufferSec`
 * (9.8 s vs 10 s) that is a coin flip per segment: **45 % of all bytes written
 * were unlinked**, 54 % duty inside windows with continuous motion.
 *
 * Keeping the windows makes the test what it always read as: does this segment
 * intersect ANY episode the operator asked to record. Bounded by
 * {@link pruneTriggerHistory} (retention) and {@link MAX_TRIGGER_WINDOWS}
 * (hard backstop), so a camera with motion every 200 ms holds ONE window, not
 * a growing list.
 *
 * ## Why a map and not two fields
 *
 * They were `{ motion, audio }`. With object detection a band must be able to
 * listen to `person` and not `vehicle`, and with sensors to device 42 and not 43.
 * A single bucket per source would make the "people only" band record on
 * every car: the live gate and the retention gate would read a signal
 * the band never asked for.
 *
 * ## The limit on KEYS
 *
 * {@link MAX_TRIGGER_WINDOWS} limits the windows per key; the keys are
 * limited by the schema — `motion` + `audio` + at most three `objectClasses`
 * (enum) + at most `MAX_SENSOR_TRIGGER_DEVICES` `sensorDeviceIds`. And
 * {@link pruneTriggerHistory} DELETES the key that empties, so a sensor
 * removed from the band stops occupying space instead of staying at zero.
 */
export interface TriggerState {
  readonly windows: ReadonlyMap<string, readonly TriggerWindow[]>
  /**
   * Sources currently HELD open — a LEVEL signal that rose and has not fallen —
   * keyed like `windows`, valued with the ms-epoch of the rise.
   *
   * A hold is not a window: it has no `lastMs`, because nothing re-emits it and
   * "now" is always inside it. The live gate reads it directly
   * ({@link eventsBandDemanded}), the keep gate treats it as
   * `[since - preBufferSec, +∞)`, and {@link releaseTrigger} turns it into an
   * ordinary window the instant the signal falls. Absent = nothing held; only
   * one source kind uses it today (`signal`, the camera's `recording-signal`).
   */
  readonly held?: ReadonlyMap<string, number>
}

/** No trigger has been seen for this device yet. */
export const EMPTY_TRIGGER_STATE: TriggerState = { windows: new Map() }

/**
 * How long a window is retained PAST the end of its own keep span
 * (`lastMs + postBufferSec`).
 *
 * A window may still be needed by a segment that has not been finalized yet.
 * The oldest such segment started one `segmentSeconds` ago, was named up to
 * {@link FIRST_SEGMENT_GRACE_MS} after the writer spawned, and is handed to the
 * keep gate after the finalize lag. 120 s covers a 60 s segment plus both, with
 * room to spare, while bounding a busy camera to a handful of windows.
 */
export const TRIGGER_HISTORY_MARGIN_MS = 120_000

/**
 * Hard backstop on retained windows per source. Retention already bounds this
 * to `TRIGGER_HISTORY_MARGIN_MS / postBufferSec` + 1 windows (3 at the shipped
 * 30 s post-buffer), so reaching this means a band with a sub-second
 * post-buffer or a clock that moved backwards. Evicting the OLDEST is the least
 * destructive choice — it is the window whose keep span expires first — and the
 * controller warns, because it drops footage.
 */
export const MAX_TRIGGER_WINDOWS = 32

/** Result of folding one trigger into the history. */
export interface TriggerRecordResult {
  readonly state: TriggerState
  /** Windows dropped to satisfy {@link MAX_TRIGGER_WINDOWS}. Normally 0. */
  readonly evicted: number
}

/** The windows for a source, in the order they opened. Empty when the source
 *  has never fired — an absent key and a source with no history are the same
 *  fact, and only one of them is ever stored. */
export function triggerWindowsFor(
  state: TriggerState,
  source: TriggerSource,
): readonly TriggerWindow[] {
  return state.windows.get(triggerKey(source)) ?? []
}

/** Replace one source's windows. An EMPTY list deletes the key rather than
 *  storing a zero-length array: that is what bounds the map when an operator
 *  removes a sensor from a band. */
function withWindows(
  state: TriggerState,
  source: TriggerSource,
  windows: readonly TriggerWindow[],
): TriggerState {
  const next = new Map(state.windows)
  const key = triggerKey(source)
  if (windows.length === 0) next.delete(key)
  else next.set(key, windows)
  return withHeld({ windows: next }, state.held)
}

/** The same state with `held` replaced — absent when there is nothing held, so
 *  a state that holds nothing is shaped exactly like one built before holds
 *  existed. */
function withHeld(
  state: TriggerState,
  held: ReadonlyMap<string, number> | undefined,
): TriggerState {
  if (held === undefined || held.size === 0) {
    const { held: _dropped, ...rest } = state
    return rest
  }
  return { ...state, held }
}

/** When the source rose, or null when it is not held. */
export function heldSinceMs(state: TriggerState, source: TriggerSource): number | null {
  return state.held?.get(triggerKey(source)) ?? null
}

/**
 * Raise a LEVEL source: from `atMs` on, the live gate demands and the keep
 * gate retains, until {@link releaseTrigger}. Idempotent — a second rise of a
 * source already held keeps the ORIGINAL rise, because the level never fell in
 * between and the footage since then belongs to the same episode. A re-emitted
 * `active: true` (a slice rewritten for another field, a reconcile read) must
 * not shorten the keep span.
 */
export function holdTrigger(
  state: TriggerState,
  source: TriggerSource,
  atMs: number,
): TriggerState {
  const key = triggerKey(source)
  if (state.held?.has(key)) return state
  const held = new Map(state.held)
  held.set(key, atMs)
  return withHeld(state, held)
}

/**
 * Lower a LEVEL source: the hold becomes the window `[since, atMs]`, folded
 * through the SAME merge every other source uses — so a rise landing inside
 * the post-buffer of the previous fall extends that episode rather than
 * opening a second one, exactly as consecutive motion triggers do. From here
 * on the band's `postBufferSec` runs and the schedule arms the close.
 *
 * A release of a source that is not held returns the SAME object: a falling
 * edge the recorder never saw rise (a runner respawn mid-job, a reconcile
 * read) has nothing to close, and the caller can skip a write.
 */
export function releaseTrigger(
  state: TriggerState,
  source: TriggerSource,
  atMs: number,
  mergeGapMs: number,
): TriggerState {
  const key = triggerKey(source)
  const since = state.held?.get(key)
  if (since === undefined) return state
  const held = new Map(state.held)
  held.delete(key)
  const span: TriggerWindow = { firstMs: since, lastMs: Math.max(since, atMs) }
  // The whole held span is ONE episode however long it lasted — it is folded
  // as a span, not as two timestamps, because a rise and a fall forty minutes
  // apart are farther than any merge gap and would otherwise become two
  // windows with the job in between unretained. It merges with an existing
  // episode only when the two lie within the post-buffer of each other.
  const merged = foldSpanInOrder(triggerWindowsFor(state, source), span, mergeGapMs)
  const evicted = Math.max(0, merged.length - MAX_TRIGGER_WINDOWS)
  return withWindows(withHeld(state, held), source, evicted > 0 ? merged.slice(evicted) : merged)
}

/**
 * Fold one span into a window list, immutably, keeping the list's INVARIANT:
 * sorted by `firstMs`, and no two windows within `mergeGapMs` of each other
 * (each is its own episode). The span EXTENDS every window it lies within the
 * merge gap of — possibly bridging two — and is otherwise INSERTED at its place
 * in time.
 *
 * Never "appended as the newest": the history is read from its end by the live
 * gate ({@link latestTriggerMs}) and by the evictor, so a span older than the
 * newest window appended after it made the newest trigger go BACKWARDS, and the
 * live gate tore down a writer whose episode was still open (D194, 2026-09-28).
 * The coalesce pass is the standard interval merge over the sorted list, so it
 * also heals a list that an older build left out of order.
 */
function foldSpanInOrder(
  windows: readonly TriggerWindow[],
  span: TriggerWindow,
  mergeGapMs: number,
): readonly TriggerWindow[] {
  const sorted = [...windows, span].toSorted((a, b) => a.firstMs - b.firstMs)
  return sorted.reduce<readonly TriggerWindow[]>((acc, w) => {
    const prev = acc[acc.length - 1]
    if (prev !== undefined && w.firstMs - prev.lastMs <= mergeGapMs) {
      return [
        ...acc.slice(0, -1),
        { firstMs: prev.firstMs, lastMs: Math.max(prev.lastMs, w.lastMs) },
      ]
    }
    return [...acc, w]
  }, [])
}

/**
 * Fold one qualifying trigger into the history, immutably. It EXTENDS the
 * window it lands within `postBufferSec` of (same episode — the recorder never
 * stopped in between), and opens a new one otherwise, IN TIME ORDER.
 *
 * An out-of-order trigger (`atMs` older than the newest window's `lastMs`, which
 * a bus lag spike or a durable row older than the bus edge can produce) never
 * rewinds anything: it widens `firstMs` of the episode it belongs to, or opens
 * its own window BEFORE the newer ones. The keep span can only ever grow, and
 * the newest trigger can only ever move forward.
 */
export function recordTrigger(
  state: TriggerState,
  source: TriggerSource,
  atMs: number,
  mergeGapMs: number,
): TriggerRecordResult {
  const merged = foldSpanInOrder(
    triggerWindowsFor(state, source),
    { firstMs: atMs, lastMs: atMs },
    mergeGapMs,
  )
  const evicted = Math.max(0, merged.length - MAX_TRIGGER_WINDOWS)
  return {
    state: withWindows(state, source, evicted > 0 ? merged.slice(evicted) : merged),
    evicted,
  }
}

/**
 * Drop windows whose keep span ended more than {@link TRIGGER_HISTORY_MARGIN_MS}
 * ago — nothing still to be finalized can intersect them. Pure; the caller
 * clocks it. Returns the SAME object when nothing expired, so a caller can skip
 * a write.
 */
export function pruneTriggerHistory(
  state: TriggerState,
  postMs: number,
  nowMs: number,
): TriggerState {
  const cutoffMs = nowMs - postMs - TRIGGER_HISTORY_MARGIN_MS
  const next = new Map<string, readonly TriggerWindow[]>()
  let changed = false
  for (const [key, windows] of state.windows) {
    const live = windows.filter((w) => w.lastMs >= cutoffMs)
    if (live.length !== windows.length) changed = true
    // A key whose last window expired is DELETED, not kept at length zero: a
    // sensor an operator removed from a band must stop costing a key.
    if (live.length > 0) next.set(key, live)
  }
  // A hold never expires here: it has no end yet. Its bound is the
  // controller's reconcile (a level nobody has re-confirmed is released
  // there), not the retention horizon of finished episodes.
  return changed ? withHeld({ windows: next }, state.held) : state
}

/**
 * Most recent trigger for a source, or null when none is retained.
 *
 * The MAXIMUM `lastMs`, not the last element's: the list is kept in time order
 * ({@link recordTrigger}), but the live gate tearing a writer down is the one
 * outcome that destroys footage, so it does not rest on an ordering invariant
 * alone (D194, 2026-09-28).
 */
export function latestTriggerMs(state: TriggerState, source: TriggerSource): number | null {
  const windows = triggerWindowsFor(state, source)
  if (windows.length === 0) return null
  return windows.reduce((max, w) => Math.max(max, w.lastMs), Number.NEGATIVE_INFINITY)
}

/**
 * Is an `events` band's live demand window open at `atMs`? True iff a trigger
 * the band listens for fired within `postBufferSec` of now. `preBufferSec` is
 * deliberately NOT consulted here (see file header).
 */
function eventsBandDemanded(band: EffectiveBand, triggers: TriggerState, atMs: number): boolean {
  const { postMs } = resolveBandBufferMs(band)
  // OR across every listened source — the operator's trigger keys are
  // ADDITIVE, and the first that says yes opens the window. A HELD source says
  // yes for as long as it is held: "now" is always inside a level.
  return bandTriggerSources(band).some((source) => {
    if (heldSinceMs(triggers, source) !== null) return true
    const lastMs = latestTriggerMs(triggers, source)
    return lastMs !== null && atMs - lastMs <= postMs
  })
}

/**
 * Should CONTINUOUS recording be active for this config at `at`?
 *
 * Returns true iff the config is enabled and the band covering `at` has
 * `mode === 'continuous'`. The v2 `activeBandAt` already encodes day/time-band
 * matching (including past-midnight wrap and the empty-days = every-day rule).
 *
 * Continuous-only gate retained for callers that classify footage as continuous
 * vs events; the live attach/detach decision now uses {@link shouldRecordAt}.
 */
export function shouldRecordContinuousAt(config: RecordingConfig, at: Date): boolean {
  if (!config.enabled) return false
  const bands = effectiveBands(config)
  if (bands.length === 0) return false
  const band = activeBandAt({ bands }, at)
  return band?.mode === 'continuous'
}

/**
 * With sound, or silent, if we record at `at`?
 *
 * NOT a recording decision — `shouldRecordAt` owns that. This answers only
 * how the footage should sound, and the safe answer to a question nobody
 * configured is the one that loses no evidence: `on`, which is byte-for-byte
 * what every band did before the key existed.
 */
export function bandAudioAt(config: RecordingConfig, at: Date): RecordingBandAudio {
  if (!config.enabled) return 'on'
  const bands = effectiveBands(config)
  if (bands.length === 0) return 'on'
  return activeBandAt({ bands }, at)?.audio ?? 'on'
}

/**
 * Should recording (any mode) be active for this device at `at`? The live
 * attach/detach gate: enabled + a band covers `at` + that band demands now
 * (continuous always; events within `postBufferSec` of a qualifying trigger).
 */
export function shouldRecordAt(config: RecordingConfig, triggers: TriggerState, at: Date): boolean {
  if (!config.enabled) return false
  const bands = effectiveBands(config)
  if (bands.length === 0) return false
  const band = activeBandAt({ bands }, at)
  if (!band) return false
  if (band.mode === 'continuous') return true
  return eventsBandDemanded(band, triggers, at.getTime())
}

/**
 * How late the FIRST segment of an attach may be NAMED, relative to the writer
 * spawn, and still count as "the segment this attach was spawned to produce".
 *
 * ffmpeg names a segment when it OPENS it, which is after the RTSP dial and the
 * first keyframe. Measured on camera 1439 (4K, H.265) on 2026-08-18: writer
 * spawned at trigger+29.5 s, first `high` segment named at trigger+32.7 s —
 * 3.2 s. 5 s carries that with margin while staying far below the writer's own
 * "this is dead" bound (`WRITER_IDLE_MIN_MS`, 90 s), so a writer that is merely
 * slow is not mistaken for one that is producing useful footage.
 */
export const FIRST_SEGMENT_GRACE_MS = 5_000

/** The attach a finalized segment came out of — the LIVE gate's decision, carried
 *  to the KEEP gate so the two cannot contradict each other. */
export interface AttachWindow {
  /** Wall clock at which this segment's ffmpeg writer was spawned. */
  readonly attachedAtMs: number
  /** Segment length that writer was spawned with (seconds). */
  readonly segmentSeconds: number
}

/**
 * Latest segment START this attach may still produce and have kept, regardless
 * of where the operator's post-buffer ended: one full segment (nothing can be
 * finalized sooner) plus {@link FIRST_SEGMENT_GRACE_MS} of spawn→first-name
 * latency.
 */
export function attachRetainDeadlineMs(attach: AttachWindow): number {
  return attach.attachedAtMs + attach.segmentSeconds * 1000 + FIRST_SEGMENT_GRACE_MS
}

/**
 * Should a finalized segment `[segStartMs, segEndMs]` recorded under an
 * `events` band be KEPT (else discarded)? Kept iff it overlaps a qualifying
 * trigger's full window `[trigger - preBufferSec, trigger + postBufferSec]` —
 * this is where `preBufferSec` retroactively retains pre-trigger footage — OR
 * it is the footage `attach` was spawned to produce (below).
 *
 * ## Why the attach matters here
 *
 * The LIVE gate ({@link shouldRecordAt}) is evaluated at wall clock; this KEEP
 * gate is evaluated on segment timestamps. They shared one window, and a writer
 * physically cannot finalize anything before `spawn + segmentSeconds + dial`.
 * So the last ~`segmentSeconds` of every demand window was a zone where the
 * recorder was GUARANTEED to attach, pull the camera, and delete 100% of the
 * result: on camera 1439 a trigger reached the recorder 29.5 s into its 30 s
 * post-buffer (hub overload, `busLagMs=142173`), ffmpeg ran 31 s, and all six
 * finalized segments were unlinked.
 *
 * The allowance is deliberately NOT a wider `postBufferSec`: it is anchored to
 * `attachedAtMs`, so a PUNCTUAL attach (the normal case) has a deadline far
 * inside `trigger + postMs` and retains exactly what it retained before. It
 * only ever extends the tail of a LATE attach, by at most one segment plus the
 * grace, and only for a trigger whose live window was still open AT ATTACH — the
 * precise statement of "if the live gate said yes, the keep gate honours the
 * first segment that decision produces". A stale trigger extends nothing.
 */
export function segmentRetainedForEvents(
  segStartMs: number,
  segEndMs: number,
  band: EffectiveBand,
  triggers: TriggerState,
  attach: AttachWindow,
): boolean {
  const { preMs, postMs } = resolveBandBufferMs(band)
  const deadlineMs = attachRetainDeadlineMs(attach)
  const overlaps = (window: TriggerWindow): boolean => {
    if (segEndMs < window.firstMs - preMs) return false
    if (segStartMs <= window.lastMs + postMs) return true
    // This window's live demand was open when the writer was spawned, and the
    // segment is one this attach could not physically have produced any sooner.
    return attach.attachedAtMs <= window.lastMs + postMs && segStartMs <= deadlineMs
  }
  return bandTriggerSources(band).some((source) => {
    // A held source is the window `[since - preBufferSec, +∞)`: everything
    // recorded since the rise (and the pre-buffer before it) is this episode.
    const since = heldSinceMs(triggers, source)
    if (since !== null && segEndMs >= since - preMs) return true
    return triggerWindowsFor(triggers, source).some(overlaps)
  })
}

/**
 * By how many ms a discarded segment missed being kept — its start past the
 * latest start that WOULD have been retained, mirroring
 * {@link segmentRetainedForEvents}'s upper bound exactly (post-buffer end, or
 * the attach allowance for a trigger that was still live at attach). Null when
 * no qualifying trigger exists at all, which is a different fact and says so.
 *
 * Negative means the segment was dropped on the PRE-buffer side (it ended
 * before `trigger - preBufferSec`), not for being late.
 *
 * Reporting-only. The discard branch has to name a number: "outside the window"
 * with no magnitude made a 2.5 s miss and a 10-minute miss indistinguishable.
 */
export function segmentMissedByMs(
  segStartMs: number,
  band: EffectiveBand,
  triggers: TriggerState,
  attach: AttachWindow,
): number | null {
  const { postMs } = resolveBandBufferMs(band)
  const deadlineMs = attachRetainDeadlineMs(attach)
  const latestKeptStart = (window: TriggerWindow): number => {
    const windowEndMs = window.lastMs + postMs
    return attach.attachedAtMs <= windowEndMs ? Math.max(windowEndMs, deadlineMs) : windowEndMs
  }
  const sources = bandTriggerSources(band)
  const holds = sources.map((source) => heldSinceMs(triggers, source)).filter((s) => s !== null)
  if (holds.length > 0) {
    // A held source retains every start from now on, so a discarded segment
    // can only have missed on the PRE side of the rise: report that distance,
    // negative, the way a pre-buffer miss against a window reads.
    return Math.min(-1, segStartMs - Math.min(...holds))
  }
  const considered: readonly TriggerWindow[] = sources.flatMap((source) => [
    ...triggerWindowsFor(triggers, source),
  ])
  if (considered.length === 0) return null
  return segStartMs - Math.max(...considered.map(latestKeptStart))
}

/** Result of folding a batch of DURABLE trigger rows into the history. */
export interface TriggerFoldResult {
  readonly state: TriggerState
  /**
   * How many rows CHANGED the history — opened a window, or widened one the
   * bus had only delivered part of. `0` means the fast path already had
   * everything, which is the normal outcome and the reason this is safe to run
   * on every reconcile beat.
   */
  readonly recovered: number
  /** Windows dropped to satisfy {@link MAX_TRIGGER_WINDOWS}. Normally 0. */
  readonly evicted: number
}

/**
 * Fold DURABLE trigger rows (the analytics store's motion timestamps) into the
 * history, immutably.
 *
 * ## Why this exists next to {@link recordTrigger}
 *
 * `recordTrigger` is fed by the event bus, and an event is telemetry that may
 * be DROPPED (D8/D11). What it feeds is not telemetry: a window the gate never
 * learned about means every segment of that episode is unlinked, and footage
 * deleted is gone. D11's own rule for that shape is "an event plus an RPC
 * reconcile", and this is the reconcile half — the same merge, over rows that
 * were persisted rather than broadcast.
 *
 * It is deliberately the SAME merge and not a second policy: a reconcile that
 * built windows by a different rule than the fast path would produce keep spans
 * that depend on which path saw the trigger, which is the two-authorities
 * failure D62 names. `recordTrigger` is called per row.
 *
 * Rows are sorted before folding: a store is free to answer newest-first, and
 * while `recordTrigger` tolerates one out-of-order arrival, a whole batch in
 * reverse would open a window per row instead of merging one episode.
 * Non-finite and non-positive timestamps are dropped rather than folded — a
 * window opened at `NaN` compares false against every segment for ever.
 */
export function foldDurableTriggers(
  state: TriggerState,
  source: TriggerSource,
  timestamps: readonly number[],
  mergeGapMs: number,
): TriggerFoldResult {
  const rows = timestamps.filter((t) => Number.isFinite(t) && t > 0).toSorted((a, b) => a - b)
  let next = state
  let recovered = 0
  let evicted = 0
  for (const atMs of rows) {
    const before = triggerWindowsFor(next, source)
    const folded = recordTrigger(next, source, atMs, mergeGapMs)
    evicted += folded.evicted
    const after = triggerWindowsFor(folded.state, source)
    // "Changed" is compared on the SPANS, not on object identity: `recordTrigger`
    // rebuilds the array every call, so identity would report every row as a
    // recovery and the log line would say the bus had lost everything, always.
    // An eviction alone is NOT a recovery: a row older than every window,
    // arriving at the bound, is inserted and evicted in the same fold — the
    // history is unchanged, and counting it would repeat the line every beat.
    // The eviction is reported on its own.
    if (
      after.length !== before.length ||
      after.some((w, i) => w.firstMs !== before[i]?.firstMs || w.lastMs !== before[i]?.lastMs)
    ) {
      recovered++
    }
    next = folded.state
  }
  return {
    state: recovered === 0 && evicted === 0 ? state : next,
    recovered,
    evicted,
  }
}
