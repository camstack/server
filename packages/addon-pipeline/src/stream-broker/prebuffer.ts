/**
 * PREBUFFER — the ONE configuration that means "this broker holds history".
 *
 * WHY THIS FILE EXISTS. Six names meant three things (D381). `preBufferEnabled`
 * and `preBufferSec` kept a source warm; `detectionPreRollMs` and
 * `recordingPreRollMs` sized the history a joiner is handed;
 * `RecordingBand.preBufferSec` restated the second of those in the recorder's
 * own units. The census of 2026-09-07 measured what that cost: on every warm
 * stream on the live hub the broker reported `preBufferSec: 10` and
 * `preBufferMs: 0` — the seconds knob sized an Annex-B ring that is never fed
 * for an RTP source, so ten configured seconds retained nothing at all, while
 * the history that DID exist was sized by two other numbers the operator was
 * never shown next to it.
 *
 * THE MODEL. One config per (device, stream), owned by the broker:
 *
 *   `enabled` — whether the source is held dialed and history is kept at all.
 *   `seconds` — how much history. The ONLY duration in this system.
 *
 * Nothing outside the broker writes either. A consumer that needs to see
 * before the edge it attached at ASKS, on its dial, and is answered
 * {@link capPreRollRequestMs} — never more than the ring actually holds. That
 * is the whole contract: the broker knows only WHETHER to prebuffer and for how
 * long; a recorder or a detector knows only how far back it would LIKE to
 * start.
 *
 * WHAT IT STILL CANNOT DO. Unchanged from the pre-roll module this replaces:
 * spending history is not creating it. A source that was cold when the trigger
 * fired has nothing to hand over, the selection falls back to the current GOP,
 * and the honest answer is a short window — which is why `enabled` is a
 * separate question from `seconds` and not a `seconds > 0` shorthand.
 */

/** A resolved prebuffer. `enabled: false` always carries `seconds: 0`. */
export interface PrebufferConfig {
  /** Whether this stream is held warm and retains history. */
  readonly enabled: boolean
  /** Seconds of history retained. `0` exactly when `enabled` is false. */
  readonly seconds: number
}

/**
 * Shipped prebuffer window.
 *
 * **5, down from 10.** The 10 was never spent: the Annex-B ring it sized is
 * not fed for RTP sources, so the number bought nothing on 22 of 22 warm
 * streams on the live hub. Under this record the seconds size the ring that
 * IS spent (source RTP), which is real memory on the ingest node: at the
 * fleet's measured bitrates — 1.7 Mbps (102), 5.1 Mbps (101), 8.0 Mbps (103) —
 * and the 1.5x GOP headroom the budget applies, 10 s costs ~3.2 / 9.5 / 15.0
 * MiB per stream and 5 s costs half of each. Across the 22 warm high streams
 * that is roughly 100 MiB saved for history no consumer had asked for: the
 * recorder's own audit set the useful window at "before the motion", which is
 * seconds, not tens of seconds. An operator who wants more raises it.
 */
export const DEFAULT_PREBUFFER_SEC = 5

/**
 * Ceiling on the prebuffer.
 *
 * Inherited verbatim from `RECORDING_PRE_ROLL_MAX_MS` (15 s), which was the
 * widest window this system could already serve, so no configuration that was
 * legal before becomes illegal now. Above this the retained bytes stop being
 * bounded by anything the operator can reason about — the byte budget starts
 * clamping instead, and a window that silently delivers less than it promises
 * is what D192 exists to forbid.
 */
export const PREBUFFER_MAX_SEC = 15

/** {@link PREBUFFER_MAX_SEC} in ms — the widest window any consumer can be served. */
export const PREBUFFER_MAX_MS = PREBUFFER_MAX_SEC * 1000

/**
 * Floor for an ENABLED prebuffer.
 *
 * Below one second no camera's keyframe interval fits, so the window can only
 * ever resolve to the current GOP — a setting that reads as ON and behaves as
 * OFF. An operator who wants OFF turns `enabled` off; that is what it is for.
 */
export const PREBUFFER_MIN_SEC = 1

/** A per-stream operator override, as persisted on the device. */
export interface StreamPrebufferOverride {
  readonly enabled: boolean
  readonly seconds: number
}

/** Inputs to the ONE prebuffer decision, in precedence order. */
export interface PrebufferResolveInput {
  /** The stream being resolved (e.g. `native:main`). */
  readonly camStreamId: string
  /** Cluster-wide seconds from the broker addon's settings. */
  readonly clusterSeconds?: number
  /** This device's per-stream overrides, if any. */
  readonly overrides?: Readonly<Record<string, StreamPrebufferOverride>>
  /**
   * True when this stream is one the broker warms by DEFAULT — today the
   * device's `high` profile. Computed by the manager, which is the only place
   * that knows the profile map.
   */
  readonly defaultWarm?: boolean
  /**
   * True when the device carries `DeviceFeature.BatteryOperated`.
   *
   * The question is what this camera IS, not what it is doing (D193): a
   * retention default that flapped with naps would make the history a
   * recording carries depend on when the operator last looked. A battery
   * camera has no permanent upstream to hold and nothing to retain between
   * wakes, so it is off — but only by DEFAULT: an explicit override still
   * reaches it, because the operator has answered the question the default was
   * guessing at.
   */
  readonly batteryOperated?: boolean
  /**
   * True for a `pull-http` relay stream — the terminal cameras.
   *
   * Warmth there is not a retained ring, it is an ffmpeg transcode running
   * forever: the glances relay measured ~12 % of a core with zero viewers.
   */
  readonly terminalRelay?: boolean
}

/** Clamp an enabled window's seconds into `[MIN, MAX]`; `0`/invalid means off. */
function clampSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PREBUFFER_SEC
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(PREBUFFER_MAX_SEC, Math.max(PREBUFFER_MIN_SEC, value))
}

/** `enabled: false` is the only representation of off — never `seconds: 0` alone. */
const OFF: PrebufferConfig = { enabled: false, seconds: 0 }

/**
 * The ONE prebuffer decision.
 *
 * Precedence: explicit per-stream override -> battery / terminal relay (off) ->
 * the profile's warm default -> off. Every layer that used to make this
 * decision somewhere else — `isDefaultWarm`, `applyPreBufferConfig`,
 * `getEffectivePreBufferSec`, `resolvePreRollMs`, `resolveRecordingPreRollMs` —
 * is this function now, so the four of them cannot disagree about one camera.
 */
export function resolvePrebuffer(input: PrebufferResolveInput): PrebufferConfig {
  const override = input.overrides?.[input.camStreamId]
  if (override !== undefined) {
    if (!override.enabled) return OFF
    const seconds = clampSeconds(override.seconds)
    return seconds > 0 ? { enabled: true, seconds } : OFF
  }
  if (input.batteryOperated === true) return OFF
  if (input.terminalRelay === true) return OFF
  if (input.defaultWarm !== true) return OFF
  const seconds = clampSeconds(input.clusterSeconds)
  return seconds > 0 ? { enabled: true, seconds } : OFF
}

/** The retention, in ms — the single number the ring is trimmed to. */
export function prebufferRetentionMs(config: PrebufferConfig): number {
  return config.enabled ? config.seconds * 1000 : 0
}

/**
 * What a consumer asking for `requestedMs` of history is actually served.
 *
 * The cap is the point of the record: a consumer states a WISH and the ring
 * states the truth.
 *
 * `requestedMs` is REQUIRED, and `0` means none (D382). It used to accept
 * `undefined` for "whatever you have", which is how every detection dial came
 * to be served the whole retained window: detection declares an intent for an
 * unrelated reason (the live-edge exemption) and never named an amount, so the
 * omission decided for it. A parameter that can be left out is a default that
 * acts without anybody choosing it — the shape D381 retired for the retention
 * and this one retires for the ask.
 *
 * A nonsense request resolves to `0`, never to the whole window: an
 * unparseable number arriving on a dial path must not be able to widen a burst.
 */
export function capPreRollRequestMs(requestedMs: number, retainedMs: number): number {
  const retained = Number.isFinite(retainedMs) && retainedMs > 0 ? retainedMs : 0
  if (retained === 0) return 0
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return 0
  return Math.min(requestedMs, retained)
}
