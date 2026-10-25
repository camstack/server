/**
 * The gate between "a `DeviceStateChanged` arrived for a mapped sensor cap"
 * and "the sensor actually CHANGED".
 *
 * ## What this fixes
 *
 * `handleSensorStateChanged` treated the ARRIVAL of the bus event as the
 * assertion, and never looked at the slice. It cannot: the kernel mirror
 * (`device-state-mirror.ts` `applySingleCapUpdate`) diffs the whole SLICE, and
 * a contact slice carries `lastChangedAt` beside `entryOpen`. Anything that
 * moves the timestamp without moving the boolean is a `DeviceStateChanged`,
 * and downstream it became a `SensorEvent` row and a synthetic `contact` track
 * on the linked camera's timeline.
 *
 * Measured on camera 101 / contact sensor 4131, 2026-08-29→30: **30 of 35**
 * contact events were one of two non-events.
 *
 *  - The RECOVERY family. The Zigbee entity flaps `off → unavailable → off`
 *    (03:22:37→03:23:28, 03:56:51→03:58:19, 04:40:05→04:45:45). The HA
 *    provider dropped the `unavailable` push and wrote the recovery, whose
 *    `entryOpen` was still `false` and whose `lastChangedAt` was HA's fresh
 *    `last_changed`. The mirror diffed, and emitted. Since D735 the provider
 *    keeps the change time of a value that did not change
 *    (`addon-provider-homeassistant` `ha-change-stamp.ts`), because this gate
 *    cannot fix the ACTIVE half: with its memory empty (a hub restart), a
 *    recovery `on` with a fresh stamp is indistinguishable here from an
 *    opening — that is how four excluded contacts pressed the armed panel on
 *    2026-10-07 02:32Z.
 *  - The COLD-SLICE family. `HaBinarySensorDevice`'s constructor writes
 *    `{ entryOpen: false, lastChangedAt: 0 }` on every device rebuild; the
 *    real state lands seconds later with a `lastChangedAt` hours old. Two
 *    emissions, no transition.
 *
 * ## Why the predicate is imported and not written here
 *
 * `evaluateSensorEdge` (`@camstack/types`) is already THE edge predicate: the
 * recorder's sensor trigger feeds it (`addon-pipeline` `recorder/sensor-trigger.ts`)
 * and so does the orchestrator's camera-sensors bridge
 * (`addon-pipeline-orchestrator` `camera-sensors/source.ts`).
 * Post-analysis was the third consumer of the same bus event and the only one
 * that did not. A second predicate here would diverge on the first cap added —
 * the exact failure [D62](../../../../../docs/decisions/adr-0062.md) names.
 *
 * ## Where it deliberately differs from the other two
 *
 * The recorder and the camera-sensors bridge want the RISING edge only. A
 * timeline marker is not a doorbell: a door CLOSING is an event an operator wants to see, and
 * the taxonomy has one `contact` kind for both directions. So this gate accepts
 * `edge: 'rising'` **and** the `falling-edge` verdict, and rejects only the
 * verdicts that mean "nothing moved" — which is precisely the 30.
 *
 * ## Caps with no boolean level pass through untouched
 *
 * `EVENT_KIND_BY_CAP` covers sixteen caps; `SOURCE_CAP_ACTIVE_FIELD` covers the
 * ten that have a boolean whose edge means something. `button`, `presence`,
 * `enum-sensor` and `event-emitter` are NOT levels — their ARRIVAL is the
 * event, and three presses in a row are three markers. Gating them would
 * re-ship the failure of 2026-08-08, when camera 101's press produced a row, a
 * ring, a matched rule and no marker. (`doorbell` is not a level either, but
 * it is not "arrival" any more: three presses are three ADVANCES of its stamp
 * — see "A press is a stamp that ADVANCES" below.)
 *
 * ## A press is a stamp that ADVANCES — not the arrival of a slice
 *
 * "Arrival is the event" held only while every emission of a `doorbell` slice
 * was a press. It is not: the slice is restored durable state (the cap's
 * `durability: 'restored'`), and it is re-emitted by everything that rebuilds
 * or re-claims it. Camera 101's composed doorbell (D670, HA
 * `switch.doorbell_bussano`) rang on 2026-10-04 19:22:46 and 2026-10-06
 * 08:10:56 with `{ lastPressedAt: null, pressCountSinceStart: <unchanged> }`:
 * the HA provider was being redeployed, the composer marked the field
 * `fresh → unavailable`, the slice lost its stamp, the mirror diffed, and
 * this gate let it through as a press. The operator received a doorbell
 * notification on every restart.
 *
 * A cap that declares a one-shot event `fromState: { field, on: 'advance' }`
 * already says, in its own `*.cap.ts`, what its event IS: that numeric field
 * strictly advancing. The composer emits `onPressed` on exactly that
 * (`strictFiniteAdvance`). So the field is read from the cap definition (no
 * second list here — D4), and the slice transitions only when it advances
 * past the last stamp this gate saw (`ADVANCE_FIELD`). A missing / null stamp
 * remembers nothing and is `no-advance`; the same or an older stamp is
 * `no-advance`. The FIRST sighting is the restart question: a stamp from
 * before this process began watching (`startedAtMs`) is restored history, not
 * a press — it seeds the baseline (`baseline-seeded-stale-active`); a stamp at
 * or after it is a press nobody has handled yet. It is the same mechanism as
 * a one-shot keyed to a persisted "last handled" marker: the marker here is
 * the durable slice itself, and the floor is the process start.
 *
 * Caps with no such declaration (`button`, `presence`, `event-emitter`) still
 * pass through on arrival.
 *
 * ## A cover — and a lock — is a level whose level is a WORD
 *
 * `cover` is the sixteenth cap, and it is neither of the above. Its level is
 * the `state` word (`open`, `opening`, `closing`, `closed`, `stopped`), and its
 * slice also carries `position`, which ticks all the way through a travel and
 * is republished unchanged by providers that poll. Passed through, every tick
 * and every republish would write a sensor-event row per linked camera and an
 * NC evaluation — so it transitions on the WORD only (`WORD_LEVEL_FIELD`):
 * `closed → opening → open` is two events, a position tick or a same-word
 * republish is a `no-change` drop.
 *
 * Its FIRST sighting follows the booleans' rule (`evaluateSensorEdge`), with
 * `closed` as the inactive word: `closed` seeds the baseline and is dropped
 * (`baseline-seeded-inactive`); any other word is an EVENT when the slice's
 * `lastChangedAt` clears the same floor, `max(startedAt, now - freshness)`,
 * and is otherwise seeded and dropped (`baseline-seeded-stale-active`). It has
 * to emit: after a runner respawn the memory is empty and the next slice is
 * usually the next REAL change, and on a two-word cover (Velux, most HA
 * covers: `closed`/`open` only) seeding it would lose the whole opening.
 *
 * Residual edges, both erring towards silence on the ambiguous case like the
 * booleans do: a cover that was already open and whose `lastChangedAt` is
 * older than the floor is not reported (a respawn cannot tell it from a
 * hydration); and a first sighting whose `lastChangedAt` is fresh only
 * because a POSITION tick moved it (the slice timestamp is not the word's)
 * is reported once as if the word had just changed. The alarm needs covers
 * to be eventful to see one open (D630).
 *
 * `lock-control` follows the same rule on its `state` word, with `locked` as
 * the resting word. It used to pass through as "arrival is the event", and a
 * lock is exactly what the alarm watches: a placeholder `unlocked` written by
 * a provider constructor after a respawn was an unlock, and the armed panel
 * could fire on it (D630).
 *
 * ## A placeholder slice is not a state
 *
 * Provider constructors write a cold slice before they have read the device —
 * `{ entryOpen: false, lastChangedAt: 0 }` for an HA binary sensor, `unlocked`
 * for an HA or Homematic lock, `closed` for an HA cover. `lastChangedAt: 0`
 * is the one field that says "nobody has read this yet", and a slice carrying
 * it is dropped BEFORE any cap-specific rule (`cold-slice`) and writes no
 * memory. Remembered, it became a baseline the real state then "changed"
 * from: a placeholder `closed` followed by the real `open` was an opening,
 * and while the panel was armed that opening could lift an exclusion and fire
 * the siren. Dropped, the real slice is a first sighting and goes through the
 * freshness floor like any other.
 *
 * The change stamp is a three-way convention every provider writes and this
 * gate and the alarm (`alarm-openings.ts`) both read:
 *
 *  - `0` — a placeholder: the VALUE is unknown. Dropped here, `unknown` there.
 *  - `> 0` but below the floor — a KNOWN value whose change time is old or
 *    unknown. A provider that REPLAYS a cached value after a respawn and has
 *    no upstream change time (Homematic: XML-RPC `getParamset` carries none)
 *    stamps it `1`, epoch + 1 ms (`HM_SEEDED_CHANGED_AT`). Here it seeds a
 *    baseline and is never a first-sighting event; there it is a real reading,
 *    so an arm check still blocks on a lock that is really unlocked. Stamping
 *    such a replay `now` is the laundering this rules out: a lock unlocked for
 *    hours cleared the floor as a fresh unlock after a hub restart.
 *  - at or above the floor — a change that happened then.
 *
 * ## Nothing here logs, and no drop is silent
 *
 * The gate is pure towards the world (no bus, no logger, no clock of its own —
 * the caller brings `now`), like the recorder's router. But it sits on a path
 * that carries every camera's native `motion` slice at motion rate — ~0.6/s
 * fleet-wide — so a line per drop would be its own outage. It accumulates
 * instead, per `(deviceId, capName, reason)`, and the caller drains one summary
 * per window. A `debug` at 3.3/s that nobody read is how a 100 %-rejection
 * regime survived three months here.
 */
import {
  DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
  evaluateSensorEdge,
  isSourceCap,
  type SensorEdgeIgnoreReason,
} from '@camstack/types'
import { CAP_ADVANCE_FIELDS } from '@camstack/types/addon'

/**
 * Caps whose level is a string word rather than a boolean: cap → slice field.
 * See "A cover is a level whose level is a WORD" above.
 */
const WORD_LEVEL_FIELD: Readonly<Record<string, string>> = {
  cover: 'state',
  'lock-control': 'state',
}

/** The word a word-level cap rests in — its `false`, for the first-sighting rule. */
const WORD_LEVEL_INACTIVE: Readonly<Record<string, string>> = {
  cover: 'closed',
  'lock-control': 'locked',
}

/**
 * Caps whose one-shot event is DERIVED from a numeric state field strictly
 * advancing: cap → field. Read from each cap's own
 * `events[*].fromState: { field, on: 'advance' }` — the declaration the
 * composer already emits from — never listed by hand here. See "A press is a
 * stamp that ADVANCES" above.
 *
 * The table is codegen'd (`CAP_ADVANCE_FIELDS`, `npm run codegen`) and
 * schema-free: this file used to derive it from `ALL_CAPABILITY_DEFINITIONS`,
 * which inlined every cap's Zod schema into the addon (~+100 MB heap per
 * post-analysis runner, D28).
 */
export const ADVANCE_FIELD: Readonly<Record<string, string>> = CAP_ADVANCE_FIELDS

/**
 * Why a slice carried no transition. The vocabulary is the shared one
 * (`SensorEdgeIgnoreReason`), which the word-level caps reuse for their
 * baselines and `no-change`; they add `non-word-value`, and every cap can
 * drop a `cold-slice`.
 */
export type SensorTransitionIgnoreReason =
  | SensorEdgeIgnoreReason
  /** A word-level cap whose slice carries no non-empty string word. */
  | 'non-word-value'
  /** A provider's placeholder (`lastChangedAt === 0`): nobody read the device yet. */
  | 'cold-slice'
  /** An advance-derived cap whose stamp is absent, null, or not past the last one seen. */
  | 'no-advance'

/**
 * Whether one slice carried a real transition.
 *
 * `changed: true` carries nothing else on purpose: the caller already holds the
 * slice, and a second copy of the value here would be a field somebody
 * eventually branches on instead of reading the cap's own contract.
 */
export type SensorTransitionVerdict =
  | { readonly changed: true }
  | { readonly changed: false; readonly reason: SensorTransitionIgnoreReason }

/** One `(device, cap, reason)` bucket of the window's drops. */
export interface SensorTransitionDropCount {
  readonly deviceId: number
  readonly capName: string
  readonly reason: SensorTransitionIgnoreReason
  readonly count: number
}

export interface SensorTransitionGateOptions {
  /**
   * When this gate started watching — the floor for a first sighting that is
   * already active. On a freshly respawned runner it is "now", which is what
   * stops a boot hydration of a long-open door reading as an opening.
   */
  readonly startedAtMs: number
  readonly now: () => number
  readonly firstSightingFreshnessMs?: number
  /** How long drops accumulate before {@link SensorTransitionGate.takeDropSummary}
   *  will hand them over. Default 10 minutes. */
  readonly summaryWindowMs?: number
}

/** Default drop-summary window: one line per device per ten minutes, at most. */
const DEFAULT_DROP_SUMMARY_WINDOW_MS = 600_000

export class SensorTransitionGate {
  /** Last observed boolean, keyed by `${deviceId}:${capName}`. */
  private readonly lastValues = new Map<string, boolean>()
  /** Last observed word of a word-level cap, keyed by `${deviceId}:${capName}`. */
  private readonly lastWords = new Map<string, string>()
  /** Highest stamp seen of an advance-derived cap, keyed by `${deviceId}:${capName}`. */
  private readonly lastStamps = new Map<string, number>()
  /** Drops since the window opened, keyed by `${deviceId}:${capName}:${reason}`. */
  private readonly drops = new Map<string, SensorTransitionDropCount>()
  private windowStartedAt: number
  private readonly startedAtMs: number
  private readonly now: () => number
  private readonly freshnessMs: number
  private readonly summaryWindowMs: number

  constructor(options: SensorTransitionGateOptions) {
    this.startedAtMs = options.startedAtMs
    this.now = options.now
    this.freshnessMs = options.firstSightingFreshnessMs ?? DEFAULT_FIRST_SIGHTING_FRESHNESS_MS
    this.summaryWindowMs = options.summaryWindowMs ?? DEFAULT_DROP_SUMMARY_WINDOW_MS
    this.windowStartedAt = options.now()
  }

  /**
   * Feed one `DeviceStateChanged` slice for a cap `EVENT_KIND_BY_CAP` maps.
   *
   * A placeholder slice (`lastChangedAt === 0`) is dropped first, for every
   * cap, and remembers nothing. Otherwise an advance-derived cap passes only
   * when its stamp advanced, a cap with no level passes through
   * unconditionally, and a cap that HAS one passes only when its level moved —
   * a boolean in either direction, or a word-level cap's word changing.
   */
  observe(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
  ): SensorTransitionVerdict {
    if (slice['lastChangedAt'] === 0) return this.drop(deviceId, capName, 'cold-slice')
    const wordField = WORD_LEVEL_FIELD[capName]
    if (wordField !== undefined) return this.observeWord(deviceId, capName, slice, wordField)
    const advanceField = ADVANCE_FIELD[capName]
    if (advanceField !== undefined) {
      return this.observeAdvance(deviceId, capName, slice[advanceField])
    }
    if (!isSourceCap(capName)) return { changed: true }
    const key = `${deviceId}:${capName}`
    const verdict = evaluateSensorEdge({
      capName,
      slice,
      prior: this.lastValues.get(key),
      startedAtMs: this.startedAtMs,
      nowMs: this.now(),
      firstSightingFreshnessMs: this.freshnessMs,
    })
    if (verdict.edge === 'rising') {
      this.lastValues.set(key, true)
      return { changed: true }
    }
    // The memory is updated only when the slice CARRIED a boolean: on
    // `unknown-cap` / `non-boolean-value` there is nothing to remember, and
    // writing one would turn a malformed slice into a baseline.
    if (verdict.value !== null) this.lastValues.set(key, verdict.value)
    if (verdict.reason === 'falling-edge') return { changed: true }
    this.noteDrop(deviceId, capName, verdict.reason)
    return { changed: false, reason: verdict.reason }
  }

  /**
   * The window's drops, or `[]` while the window is still open. Draining opens
   * the next window.
   *
   * Sorted by `(deviceId, capName, reason)` so a line is comparable with the
   * previous window's without the reader re-sorting it.
   */
  takeDropSummary(nowMs: number): readonly SensorTransitionDropCount[] {
    if (nowMs - this.windowStartedAt < this.summaryWindowMs) return []
    this.windowStartedAt = nowMs
    if (this.drops.size === 0) return []
    const out = [...this.drops.values()].sort(
      (a, b) =>
        a.deviceId - b.deviceId ||
        a.capName.localeCompare(b.capName) ||
        a.reason.localeCompare(b.reason),
    )
    this.drops.clear()
    return out
  }

  /**
   * A word-level cap: a transition is the word changing. The memory is
   * written only when the slice CARRIED a word, for the same reason as the
   * booleans — a malformed slice must not become a baseline.
   */
  private observeWord(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
    wordField: string,
  ): SensorTransitionVerdict {
    const raw = slice[wordField]
    if (typeof raw !== 'string' || raw.length === 0) {
      return this.drop(deviceId, capName, 'non-word-value')
    }
    const key = `${deviceId}:${capName}`
    const prior = this.lastWords.get(key)
    this.lastWords.set(key, raw)
    if (prior === undefined) return this.firstWordSighting(deviceId, capName, slice, raw)
    if (prior === raw) return this.drop(deviceId, capName, 'no-change')
    return { changed: true }
  }

  /**
   * An advance-derived cap (`doorbell.lastPressedAt`): a transition is the stamp
   * strictly advancing past the last one seen — the composer's own
   * `strictFiniteAdvance`. A stamp that is absent / null / non-finite / not
   * positive remembers nothing (a source going unavailable must not erase the
   * baseline the recovery is compared against). First sighting: a stamp from
   * before this gate began watching is restored history and seeds.
   */
  private observeAdvance(deviceId: number, capName: string, raw: unknown): SensorTransitionVerdict {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      return this.drop(deviceId, capName, 'no-advance')
    }
    const key = `${deviceId}:${capName}`
    const prior = this.lastStamps.get(key)
    if (prior !== undefined && raw <= prior) return this.drop(deviceId, capName, 'no-advance')
    this.lastStamps.set(key, raw)
    if (prior === undefined && raw < this.startedAtMs) {
      return this.drop(deviceId, capName, 'baseline-seeded-stale-active')
    }
    return { changed: true }
  }

  /**
   * The booleans' first-sighting rule, on a word: the resting word seeds; any
   * other word is an event only when the slice's own `lastChangedAt` clears
   * the SAME floor `evaluateSensorEdge` uses, from the same two knobs.
   */
  private firstWordSighting(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
    word: string,
  ): SensorTransitionVerdict {
    if (word === WORD_LEVEL_INACTIVE[capName]) {
      return this.drop(deviceId, capName, 'baseline-seeded-inactive')
    }
    const changedAt = slice['lastChangedAt']
    const floor = Math.max(this.startedAtMs, this.now() - this.freshnessMs)
    const fresh =
      typeof changedAt === 'number' &&
      Number.isFinite(changedAt) &&
      changedAt > 0 &&
      changedAt >= floor
    if (!fresh) return this.drop(deviceId, capName, 'baseline-seeded-stale-active')
    return { changed: true }
  }

  private drop(
    deviceId: number,
    capName: string,
    reason: SensorTransitionIgnoreReason,
  ): SensorTransitionVerdict {
    this.noteDrop(deviceId, capName, reason)
    return { changed: false, reason }
  }

  private noteDrop(deviceId: number, capName: string, reason: SensorTransitionIgnoreReason): void {
    const key = `${deviceId}:${capName}:${reason}`
    const prior = this.drops.get(key)
    this.drops.set(key, {
      deviceId,
      capName,
      reason,
      count: (prior?.count ?? 0) + 1,
    })
  }
}
