import { describe, it, expect } from 'vitest'
import { DEFAULT_EVENTS_BAND_BUFFER_SEC } from '@camstack/types'
import type { RecordingConfig, RecordingBand } from '@camstack/types'
import {
  type AttachWindow,
  attachRetainDeadlineMs,
  audioLevelQualifies,
  bandTriggerSources,
  eventsBandCanEverDemand,
  FIRST_SEGMENT_GRACE_MS,
  shouldRecordContinuousAt,
  shouldRecordAt,
  segmentMissedByMs,
  segmentRetainedForEvents,
  EMPTY_TRIGGER_STATE,
  foldDurableTriggers,
  MAX_TRIGGER_WINDOWS,
  pruneTriggerHistory,
  recordTrigger,
  resolveBandBufferMs,
  TRIGGER_HISTORY_MARGIN_MS,
  TRIGGER_KEY_TO_SOURCE_KIND,
  triggerKey,
  triggerWindowsFor,
  latestTriggerMs,
  holdTrigger,
  releaseTrigger,
  UNFED_TRIGGER_KEYS,
  type TriggerSource,
  type TriggerState,
  type TriggerWindow,
} from '../band-decision.js'
import { PREBUFFER_MAX_MS } from '../../../stream-broker/prebuffer.js'

// A Wednesday 2026-06-17 10:00 local time anchor for band-window tests.
const wed1000 = new Date('2026-06-17T10:00:00')
const wed2300 = new Date('2026-06-17T23:00:00')

function cfg(partial: Partial<RecordingConfig>): RecordingConfig {
  return { enabled: true, bands: [], ...partial }
}

const NO_TRIGGERS: TriggerState = EMPTY_TRIGGER_STATE

const MOTION: TriggerSource = { kind: 'motion' }
const AUDIO: TriggerSource = { kind: 'audio' }

/**
 * Build a `TriggerState` from explicit windows — the shape these tests wrote
 * as `{ motion: [...], audio: [...] }` before the state became KEYED (Track
 * A1). Mechanical port: the assertions below are unchanged, only the fixture
 * that produces the state is.
 */
const triggerStateOf = (
  entries: readonly (readonly [TriggerSource, readonly TriggerWindow[]])[],
): TriggerState => ({
  windows: new Map(
    entries.filter(([, w]) => w.length > 0).map(([src, w]) => [triggerKey(src), w] as const),
  ),
})

const motionState = (windows: readonly TriggerWindow[]): TriggerState =>
  triggerStateOf([[MOTION, windows]])
const audioState = (windows: readonly TriggerWindow[]): TriggerState =>
  triggerStateOf([[AUDIO, windows]])

const eventsBand = (triggers: RecordingBand['triggers']): RecordingBand => ({
  days: [],
  start: '00:00',
  end: '23:59',
  mode: 'events',
  triggers,
})

/**
 * Track 0 — audioThresholdDbfs goes from "dead knob" to "wired trigger".
 *
 * Before 2026-08-26 the only production call site of `onTrigger` passed
 * `'motion'`, so `bandTriggerSources` could not include `'audio'` without
 * lying: a band that listened to audio ONLY passed
 * `eventsBandCanEverDemand` and never recorded, without a line (D62). Track
 * 0 does not remove it — it wires it: `RecordingController.onAudioLevel`
 * now calls `onTrigger(deviceId, 'audio', atMs)` when the level
 * of the last window qualifies against the threshold of the active band. With the
 * real feed, `bandTriggerSources` can include `'audio'` and stay honest.
 */
describe('bandTriggerSources / eventsBandCanEverDemand — every declared source is fed', () => {
  it('a band without any trigger can never demand', () => {
    expect(bandTriggerSources(eventsBand(undefined))).toEqual([])
    expect(eventsBandCanEverDemand(eventsBand(undefined))).toBe(false)
  })

  it('motion basta ad aprire la finestra', () => {
    expect(bandTriggerSources(eventsBand({ motion: true }))).toEqual([MOTION])
    expect(eventsBandCanEverDemand(eventsBand({ motion: true }))).toBe(true)
  })

  it('a band that listens to audio ONLY can now demand — the feed exists', () => {
    // Before Track 0 this was `false`: nobody called
    // `onTrigger(_, 'audio', _)`. Now `RecordingController.onAudioLevel` does
    // (see recording-controller.spec.ts), so the source is honest.
    expect(bandTriggerSources(eventsBand({ audioThresholdDbfs: -30 }))).toEqual([AUDIO])
    expect(eventsBandCanEverDemand(eventsBand({ audioThresholdDbfs: -30 }))).toBe(true)
  })

  it('motion + audio: both sources', () => {
    expect(bandTriggerSources(eventsBand({ motion: true, audioThresholdDbfs: -30 }))).toEqual([
      MOTION,
      AUDIO,
    ])
  })

  it('maps every key of the trigger schema to its TriggerSource — read from the guard', () => {
    expect(TRIGGER_KEY_TO_SOURCE_KIND['motion']).toBe('motion')
    expect(TRIGGER_KEY_TO_SOURCE_KIND['audioThresholdDbfs']).toBe('audio')
  })

  it('UNFED_TRIGGER_KEYS is empty: every declared key has a real feed', () => {
    expect([...UNFED_TRIGGER_KEYS]).toEqual([])
  })
})

/**
 * The unknown resolved before writing the comparison: `PipelineAudioInferenceResultPayload.frame.level.dbfs`
 * (`packages/types/src/types/detection.ts:448`) and `RecordingTriggers.audioThresholdDbfs`
 * are the SAME scale — dBFS, produced by `AudioAnalyzerProvider.analyseChunk` (`audio-analyzer/addons/analyzer/index.ts`)
 * (`20 * log10(rms)`) — so the comparison is a `>=` with no conversion, like
 * the only other place in the repo that compares the same two values
 * (`notification-center/audio-rule-matcher.ts:221`).
 */
describe('audioLevelQualifies — same scale, no conversion', () => {
  it('qualifies when the level is LOUDER (less negative) than the threshold', () => {
    expect(audioLevelQualifies(eventsBand({ audioThresholdDbfs: -30 }), -20)).toBe(true)
  })

  it('is inclusive at the edge — equal to the threshold qualifies', () => {
    expect(audioLevelQualifies(eventsBand({ audioThresholdDbfs: -30 }), -30)).toBe(true)
  })

  it('does not qualify when the level is QUIETER (more negative) than the threshold', () => {
    expect(audioLevelQualifies(eventsBand({ audioThresholdDbfs: -30 }), -40)).toBe(false)
  })

  it('no active band → never qualifies', () => {
    expect(audioLevelQualifies(null, -5)).toBe(false)
  })

  it('a band without a configured audioThresholdDbfs → does not qualify, whatever the level', () => {
    expect(audioLevelQualifies(eventsBand({ motion: true }), 0)).toBe(false)
  })
})

describe('shouldRecordContinuousAt', () => {
  it('returns false when disabled even if a continuous band covers now', () => {
    const config = cfg({
      enabled: false,
      bands: [{ days: [], start: '00:00', end: '23:59', mode: 'continuous' }],
    })
    expect(shouldRecordContinuousAt(config, wed1000)).toBe(false)
  })

  it('returns false when there are no bands', () => {
    expect(shouldRecordContinuousAt(cfg({ bands: [] }), wed1000)).toBe(false)
  })

  it('returns true inside an all-day continuous band', () => {
    const config = cfg({
      bands: [{ days: [], start: '00:00', end: '23:59', mode: 'continuous' }],
    })
    expect(shouldRecordContinuousAt(config, wed1000)).toBe(true)
  })

  it('returns true inside a daytime continuous band, false outside it', () => {
    const config = cfg({
      bands: [{ days: [], start: '08:00', end: '18:00', mode: 'continuous' }],
    })
    expect(shouldRecordContinuousAt(config, wed1000)).toBe(true)
    expect(shouldRecordContinuousAt(config, wed2300)).toBe(false)
  })

  it('treats an events band as NOT continuous (B2 defers trigger-gating to B3)', () => {
    const config = cfg({
      bands: [{ days: [], start: '00:00', end: '23:59', mode: 'events' }],
    })
    expect(shouldRecordContinuousAt(config, wed1000)).toBe(false)
  })

  it('respects the weekday filter of a continuous band', () => {
    // Wed = day 3; band only covers Mon(1)/Tue(2).
    const config = cfg({
      bands: [{ days: [1, 2], start: '00:00', end: '23:59', mode: 'continuous' }],
    })
    expect(shouldRecordContinuousAt(config, wed1000)).toBe(false)
  })

  it('picks the first covering band — continuous wins when it covers now', () => {
    const config = cfg({
      bands: [
        { days: [], start: '08:00', end: '18:00', mode: 'continuous' },
        { days: [], start: '00:00', end: '23:59', mode: 'events' },
      ],
    })
    expect(shouldRecordContinuousAt(config, wed1000)).toBe(true)
  })
})

describe('shouldRecordAt (B3 — events-band trigger gating)', () => {
  const at = wed1000.getTime()
  const eventsMotion = (post: number): RecordingConfig =>
    cfg({
      bands: [
        {
          days: [],
          start: '00:00',
          end: '23:59',
          mode: 'events',
          triggers: { motion: true },
          postBufferSec: post,
        },
      ],
    })

  it('still records continuously inside a continuous band regardless of triggers', () => {
    const config = cfg({
      bands: [{ days: [], start: '00:00', end: '23:59', mode: 'continuous' }],
    })
    expect(shouldRecordAt(config, NO_TRIGGERS, wed1000)).toBe(true)
  })

  it('events band: false with no trigger', () => {
    expect(shouldRecordAt(eventsMotion(30), NO_TRIGGERS, wed1000)).toBe(false)
  })

  it('events band: true within postBufferSec of a motion trigger', () => {
    const triggers: TriggerState = motionState([{ firstMs: at - 10_000, lastMs: at - 10_000 }])
    expect(shouldRecordAt(eventsMotion(30), triggers, wed1000)).toBe(true)
  })

  it('events band: false once postBufferSec has elapsed since the last trigger', () => {
    const triggers: TriggerState = motionState([{ firstMs: at - 40_000, lastMs: at - 40_000 }])
    expect(shouldRecordAt(eventsMotion(30), triggers, wed1000)).toBe(false)
  })

  it('events band: a motion trigger does NOT arm a band that only triggers on audio', () => {
    const audioBand = cfg({
      bands: [
        {
          days: [],
          start: '00:00',
          end: '23:59',
          mode: 'events',
          triggers: { audioThresholdDbfs: -30 },
          postBufferSec: 30,
        },
      ],
    })
    const triggers: TriggerState = motionState([{ firstMs: at - 5_000, lastMs: at - 5_000 }])
    expect(shouldRecordAt(audioBand, triggers, wed1000)).toBe(false)
  })

  it('events band: an audio trigger arms an audio-triggered band', () => {
    const audioBand = cfg({
      bands: [
        {
          days: [],
          start: '00:00',
          end: '23:59',
          mode: 'events',
          triggers: { audioThresholdDbfs: -30 },
          postBufferSec: 30,
        },
      ],
    })
    const triggers: TriggerState = audioState([{ firstMs: at - 5_000, lastMs: at - 5_000 }])
    expect(shouldRecordAt(audioBand, triggers, wed1000)).toBe(true)
  })

  it('returns false when disabled even with a fresh trigger', () => {
    const config = { ...eventsMotion(30), enabled: false }
    expect(shouldRecordAt(config, motionState([{ firstMs: at, lastMs: at }]), wed1000)).toBe(false)
  })

  it('returns false outside the events band window even with a fresh trigger', () => {
    const config = cfg({
      bands: [
        {
          days: [],
          start: '08:00',
          end: '09:00',
          mode: 'events',
          triggers: { motion: true },
          postBufferSec: 30,
        },
      ],
    })
    expect(shouldRecordAt(config, motionState([{ firstMs: at, lastMs: at }]), wed1000)).toBe(false)
  })

  // ── The shape production actually persists ────────────────────────────────
  //
  // Every case above hands the band an explicit `postBufferSec`. The Basic
  // recording form does NOT: `bandsFromFormState` omits the field entirely when
  // the operator leaves the (blank, placeholder "0") post-buffer input alone, so
  // the persisted band is `{mode:'events', triggers:{motion:true}}` and nothing
  // else. Read with a bare `?? 0` that made the live demand window zero-length —
  // unopenable at any instant after the trigger — which is how two cameras were
  // configured to record for weeks and wrote nothing, with no log line either.
  // The fixture supplying what production omits is exactly why the suite was
  // green.
  const eventsMotionNoBuffers = (): RecordingConfig =>
    cfg({
      bands: [
        {
          days: [],
          start: '00:00',
          end: '23:59',
          mode: 'events',
          triggers: { motion: true },
        },
      ],
    })

  it('events band with NO postBufferSec: records just after a motion trigger', () => {
    const triggers: TriggerState = motionState([{ firstMs: at - 250, lastMs: at - 250 }])
    expect(shouldRecordAt(eventsMotionNoBuffers(), triggers, wed1000)).toBe(true)
  })

  it('events band with NO postBufferSec: still records one segment length later', () => {
    const triggers: TriggerState = motionState([{ firstMs: at - 12_000, lastMs: at - 12_000 }])
    expect(shouldRecordAt(eventsMotionNoBuffers(), triggers, wed1000)).toBe(true)
  })

  it('events band with NO postBufferSec: stops once the default window has elapsed', () => {
    const beyond = DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec * 1000 + 1_000
    const triggers: TriggerState = motionState([{ firstMs: at - beyond, lastMs: at - beyond }])
    expect(shouldRecordAt(eventsMotionNoBuffers(), triggers, wed1000)).toBe(false)
  })

  it('an EXPLICIT postBufferSec of 0 stays 0 — the operator said so', () => {
    const triggers: TriggerState = motionState([{ firstMs: at - 250, lastMs: at - 250 }])
    expect(shouldRecordAt(eventsMotion(0), triggers, wed1000)).toBe(false)
  })
})

describe('segmentRetainedForEvents (B3 — retroactive pre/post-buffer keep)', () => {
  const T = wed1000.getTime()
  const band: RecordingBand = {
    days: [],
    start: '00:00',
    end: '23:59',
    mode: 'events',
    triggers: { motion: true },
    // No `preBufferSec`: a band does not carry one any more (D381). The keep
    // gate's pre-side is `PREBUFFER_MAX_MS`, the widest history the broker can
    // hand the writer, for EVERY band — see the invariant at the bottom.
    postBufferSec: 30,
  }
  const motion = (t: number): TriggerState => motionState([{ firstMs: t, lastMs: t }])

  const SEGMENT_SECONDS = 10
  /**
   * The normal case: the writer was spawned the instant the trigger arrived. Its
   * allowance (`T + segmentSeconds + grace` = T+15s) is far INSIDE the post
   * buffer (T+30s), so every assertion below is bounded by the operator's window
   * exactly as it was before the attach allowance existed.
   */
  const punctualAttach: AttachWindow = {
    attachedAtMs: T,
    segmentSeconds: SEGMENT_SECONDS,
  }
  /** Camera 1439, 2026-08-18: the trigger reached the recorder 29.5 s into its
   *  30 s post buffer (hub overload, `busLagMs=142173`) and the writer spawned
   *  there — 460 ms before the window it was opened for closed. */
  const lateAttach: AttachWindow = {
    attachedAtMs: T + 29_500,
    segmentSeconds: SEGMENT_SECONDS,
  }

  it('keeps a segment recorded during the post-buffer window', () => {
    expect(segmentRetainedForEvents(T, T + 4_000, band, motion(T), punctualAttach)).toBe(true)
  })

  it('keeps a pre-buffer segment finalized just before the trigger (within preBufferSec)', () => {
    expect(segmentRetainedForEvents(T - 4_000, T, band, motion(T), punctualAttach)).toBe(true)
  })

  it('discards a segment entirely before the pre-buffer window', () => {
    // The pre-side of the keep window is `PREBUFFER_MAX_MS` now, not a band
    // number, so "entirely before it" is measured from that ceiling: this
    // segment's media ENDS a second before the earliest instant the broker
    // could ever have handed the writer.
    const endsBeforeTheWindow = T - PREBUFFER_MAX_MS - 1_000
    expect(
      segmentRetainedForEvents(
        endsBeforeTheWindow - 6_000,
        endsBeforeTheWindow,
        band,
        motion(T),
        punctualAttach,
      ),
    ).toBe(false)
  })

  /**
   * THE ASSERTION THAT ENSHRINED THE BUG, and what replaced it.
   *
   * The old test asserted one thing about this segment: `[T+31s, T+35s]` is
   * outside `[T-pre, T+post]`, therefore discard. About the FUNCTION that was
   * right, and it still is — for a writer that was spawned on time (first case
   * below). About the SYSTEM it was wrong, because it never asked where the
   * segment came from. A writer spawned at T+29.5s cannot name its first
   * segment before ~T+33s, so under the old rule that attach — which the LIVE
   * gate had just authorised — was guaranteed to have 100% of its output
   * deleted. Same segment, same band, same trigger: the only difference is the
   * attach, and the verdicts have to differ.
   */
  it('discards a segment after the post-buffer window when the writer attached ON TIME', () => {
    expect(segmentRetainedForEvents(T + 31_000, T + 35_000, band, motion(T), punctualAttach)).toBe(
      false,
    )
  })

  it('KEEPS that same segment when it is the first one a late attach could produce', () => {
    expect(segmentRetainedForEvents(T + 31_000, T + 35_000, band, motion(T), lateAttach)).toBe(true)
  })

  it('the allowance is bounded — a late attach does not keep recording forever', () => {
    // One segment plus the grace past the spawn, and not a millisecond more:
    // the deadline is anchored to the ATTACH, not to the operator's buffer.
    const deadline = attachRetainDeadlineMs(lateAttach)
    expect(deadline).toBe(T + 29_500 + SEGMENT_SECONDS * 1000 + FIRST_SEGMENT_GRACE_MS)
    expect(segmentRetainedForEvents(deadline, deadline + 10_000, band, motion(T), lateAttach)).toBe(
      true,
    )
    expect(
      segmentRetainedForEvents(deadline + 1, deadline + 10_000, band, motion(T), lateAttach),
    ).toBe(false)
  })

  it('a STALE trigger extends nothing — the allowance needs a window open AT ATTACH', () => {
    // This attach was not authorised by this trigger (its window closed 10
    // minutes before the writer spawned), so the first-segment allowance must
    // not resurrect it. Only the live gate's own decision earns the extension.
    const staleAttach: AttachWindow = {
      attachedAtMs: T + 600_000,
      segmentSeconds: SEGMENT_SECONDS,
    }
    expect(segmentRetainedForEvents(T + 601_000, T + 611_000, band, motion(T), staleAttach)).toBe(
      false,
    )
  })

  it('discards everything when no qualifying trigger exists', () => {
    expect(segmentRetainedForEvents(T, T + 4_000, band, NO_TRIGGERS, punctualAttach)).toBe(false)
  })

  it('ignores an audio trigger for a motion-only band', () => {
    expect(
      segmentRetainedForEvents(
        T,
        T + 4_000,
        band,
        audioState([{ firstMs: T, lastMs: T }]),
        punctualAttach,
      ),
    ).toBe(false)
  })

  // Same omission as the live gate: a band authored through the Basic form
  // carries neither buffer, and a bare `?? 0` kept only the segment straddling
  // the trigger instant — every segment the post-buffer paid to record was
  // deleted on finalize.
  const bareBand: RecordingBand = {
    days: [],
    start: '00:00',
    end: '23:59',
    mode: 'events',
    triggers: { motion: true },
  }

  it('band with NO buffers: keeps the segment finalized after the trigger', () => {
    expect(
      segmentRetainedForEvents(T + 10_000, T + 20_000, bareBand, motion(T), punctualAttach),
    ).toBe(true)
  })

  it('band with NO buffers: keeps the pre-trigger segment the default pre-buffer covers', () => {
    expect(
      segmentRetainedForEvents(T - 9_000, T - 1_000, bareBand, motion(T), punctualAttach),
    ).toBe(true)
  })

  it('band with NO buffers: still discards a segment beyond the default window', () => {
    const beyond = DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec * 1000 + 1_000
    expect(
      segmentRetainedForEvents(T + beyond, T + beyond + 4_000, bareBand, motion(T), punctualAttach),
    ).toBe(false)
  })

  describe('segmentMissedByMs — the discard log has to name a magnitude', () => {
    it('reports the miss against the operator window for a punctual attach', () => {
      expect(segmentMissedByMs(T + 31_000, band, motion(T), punctualAttach)).toBe(1_000)
    })

    it('reports the miss against the ATTACH allowance when that is the later bound', () => {
      const deadline = attachRetainDeadlineMs(lateAttach)
      expect(segmentMissedByMs(deadline + 2_500, band, motion(T), lateAttach)).toBe(2_500)
    })

    it('is null when no qualifying trigger exists — a different fact', () => {
      expect(segmentMissedByMs(T + 31_000, band, NO_TRIGGERS, punctualAttach)).toBe(null)
    })
  })
})

/**
 * The defect the trigger HISTORY exists for (audit 2026-08-20).
 *
 * A finalized segment reaches the keep gate long after the media in it was
 * captured — measured p50 9.8 s. Under continuous motion the scalar gate
 * compared that segment against the LATEST trigger, which had kept advancing
 * the whole time, so `segEndMs < lastMotionMs - preBufferSec` deleted the
 * earlier part of the very episode the recorder had been started for. With
 * finalize lag (9.8 s) ~= `preBufferSec` (10 s) it was a coin flip per segment:
 * 45 % of every byte written was unlinked, 54 % duty on windows with continuous
 * motion.
 */
describe('segmentRetainedForEvents — an OPEN episode keeps its own footage', () => {
  const T = wed1000.getTime()
  const band: RecordingBand = {
    days: [],
    start: '00:00',
    end: '23:59',
    mode: 'events',
    triggers: { motion: true },
    postBufferSec: 30,
  }
  const attach: AttachWindow = { attachedAtMs: T, segmentSeconds: 10 }
  const POST_MS = 30_000

  /** Motion every 2 s from T for `spanMs`, folded exactly as the controller does. */
  function episode(spanMs: number): TriggerState {
    let state = EMPTY_TRIGGER_STATE
    for (let at = T; at <= T + spanMs; at += 2_000) {
      state = recordTrigger(state, MOTION, at, POST_MS).state
    }
    return state
  }

  it('keeps the FIRST segment of an episode that is still firing 20.5 s later', () => {
    // The scalar gate returned false here: segEnd (T+10 s) < lastMotion
    // (T+20.5 s) - preBufferSec (10 s) = T+10.5 s. This is THE deletion.
    expect(segmentRetainedForEvents(T, T + 10_000, band, episode(20_500), attach)).toBe(true)
  })

  it('keeps every segment of a 10-minute continuous-motion episode', () => {
    const triggers = episode(600_000)
    for (let start = T; start < T + 600_000; start += 10_000) {
      expect(segmentRetainedForEvents(start, start + 10_000, band, triggers, attach)).toBe(true)
    }
  })

  it('still discards footage no episode ever asked for, between two episodes', () => {
    let state = recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T, POST_MS).state
    // 10 minutes later — far beyond the merge gap, so a SECOND episode.
    state = recordTrigger(state, MOTION, T + 600_000, POST_MS).state
    expect(triggerWindowsFor(state, MOTION)).toHaveLength(2)
    // Between the first episode's post-buffer and the second's pre-buffer.
    expect(segmentRetainedForEvents(T + 200_000, T + 210_000, band, state, attach)).toBe(false)
    // …while both episodes still keep their own.
    expect(segmentRetainedForEvents(T, T + 10_000, band, state, attach)).toBe(true)
    expect(segmentRetainedForEvents(T + 600_000, T + 610_000, band, state, attach)).toBe(true)
  })
})

describe('recordTrigger / pruneTriggerHistory — the history stays bounded', () => {
  const T = wed1000.getTime()
  const POST_MS = 30_000

  it('merges triggers inside the post-buffer into ONE episode', () => {
    let state = EMPTY_TRIGGER_STATE
    for (let at = T; at <= T + 300_000; at += 2_000) {
      state = recordTrigger(state, MOTION, at, POST_MS).state
    }
    expect(triggerWindowsFor(state, MOTION)).toEqual([{ firstMs: T, lastMs: T + 300_000 }])
  })

  it('opens a new episode once the post-buffer has lapsed', () => {
    const first = recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T, POST_MS).state
    const second = recordTrigger(first, MOTION, T + POST_MS + 1, POST_MS).state
    expect(triggerWindowsFor(second, MOTION)).toHaveLength(2)
  })

  it('never rewinds an episode on an out-of-order trigger — the span only grows', () => {
    const opened = recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T + 10_000, POST_MS).state
    const late = recordTrigger(opened, MOTION, T + 1_000, POST_MS).state
    expect(triggerWindowsFor(late, MOTION)).toEqual([{ firstMs: T + 1_000, lastMs: T + 10_000 }])
  })

  it('keeps motion and audio histories independent', () => {
    const state = recordTrigger(
      recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T, POST_MS).state,
      AUDIO,
      T + 500_000,
      POST_MS,
    ).state
    expect(triggerWindowsFor(state, MOTION)).toHaveLength(1)
    expect(triggerWindowsFor(state, AUDIO)).toHaveLength(1)
  })

  it('drops an episode once nothing unfinalized can still intersect it', () => {
    const state = recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T, POST_MS).state
    const stillNeeded = T + POST_MS + TRIGGER_HISTORY_MARGIN_MS
    expect(
      triggerWindowsFor(pruneTriggerHistory(state, POST_MS, stillNeeded), MOTION),
    ).toHaveLength(1)
    expect(
      triggerWindowsFor(pruneTriggerHistory(state, POST_MS, stillNeeded + 1), MOTION),
    ).toHaveLength(0)
  })

  it('returns the SAME object when nothing expired', () => {
    const state = recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T, POST_MS).state
    expect(pruneTriggerHistory(state, POST_MS, T + 1_000)).toBe(state)
  })

  it('evicts the OLDEST past the hard bound, and says how many', () => {
    let state = EMPTY_TRIGGER_STATE
    let evictions = 0
    // Each trigger is its own episode (gap > merge gap), so the bound bites.
    for (let i = 0; i <= MAX_TRIGGER_WINDOWS; i++) {
      const result = recordTrigger(state, MOTION, T + i * (POST_MS + 1_000), POST_MS)
      state = result.state
      evictions += result.evicted
    }
    expect(triggerWindowsFor(state, MOTION)).toHaveLength(MAX_TRIGGER_WINDOWS)
    expect(evictions).toBe(1)
    expect(triggerWindowsFor(state, MOTION)[0]!.firstMs).toBe(T + (POST_MS + 1_000))
  })
})

/**
 * THE contract between the two ends of the pre-roll (audit 2026-08-20,
 * re-expressed against the ONE prebuffer, D381).
 *
 * There is ONE retention in this system and it belongs to the broker: the ring
 * `getRtpPreRollBuffer` serves, sized by that stream's prebuffer, bounded by
 * `PREBUFFER_MAX_MS`. The recorder never configures a second one — it declares
 * the recording intent on its dial and receives whatever the ring held.
 *
 * The keep gate's pre-side is therefore NOT a second pre-roll knob, and as of
 * D381 it is not a knob at all. It only ever stayed honest while it was at
 * least as wide as the history the broker can actually serve — wider is safe
 * (it can only over-keep footage that exists); NARROWER deletes media the
 * broker just handed the writer, which is the one direction that destroys work.
 *
 * The invariant used to be a GUARD against drift between two numbers an
 * operator maintained by hand. It is now true BY CONSTRUCTION:
 * `resolveBandBufferMs` returns `PREBUFFER_MAX_MS` itself, so the narrower case
 * is unrepresentable rather than merely detected. These tests pin exactly that
 * — that no band SHAPE, including the ones that used to carry a number, can
 * produce a different pre-side.
 */
describe('pre-roll contract: the gate can never be narrower than the ring', () => {
  const bandOf = (extra: Partial<RecordingBand>): RecordingBand => ({
    days: [],
    start: '00:00',
    end: '23:59',
    mode: 'events',
    triggers: { motion: true },
    ...extra,
  })

  /**
   * The DIRECTIONAL guard (D193), now stated as an identity. The keep bound is
   * the retroactive KEEP bound (D191); the broker's prebuffer is media it hands
   * the writer from BEFORE the trigger. If the keep bound were narrower, the
   * recorder would delete footage the broker just gave it — the two authorities
   * disagreeing about the same seconds, which is the failure D191 and D192 were
   * both written against. There are no longer two authorities: the gate READS
   * the ceiling.
   *
   * Every band shape is covered, including the one that authored an explicit
   * `0` — that number is retired and stripped on load
   * (`stripRetiredBandPreBufferSec`), so it can no longer narrow anything even
   * when it survives in a persisted config.
   */
  it('every band shape resolves the SAME pre-side: the prebuffer ceiling', () => {
    const shapes: readonly RecordingBand[] = [
      bandOf({}),
      bandOf({ postBufferSec: 30 }),
      bandOf({ postBufferSec: 0 }),
      bandOf({ mode: 'continuous' }),
      // The retired knob, at the two values that used to matter: an explicit
      // `0` (the narrowest an operator could express) and a number narrower
      // than the ring. Neither is read any more.
      bandOf({ preBufferSec: 0, postBufferSec: 30 }),
      bandOf({ preBufferSec: 2, postBufferSec: 30 }),
    ]
    for (const band of shapes) {
      expect(resolveBandBufferMs(band).preMs).toBe(PREBUFFER_MAX_MS)
    }
  })

  it('…and the default band the recorder ships with is that same ceiling', () => {
    // `DEFAULT_EVENTS_BAND_BUFFER_SEC` carries only `postBufferSec` now: there
    // is nothing left in it that could be narrower than the ring.
    expect(resolveBandBufferMs(bandOf({})).preMs).toBe(PREBUFFER_MAX_MS)
    expect(resolveBandBufferMs(bandOf({})).postMs).toBe(
      DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec * 1000,
    )
  })

  /**
   * What the retired explicit `preBufferSec: 0` does now.
   *
   * It used to be an operator instruction honoured verbatim, and it was the one
   * case the invariant above deliberately did NOT cover. D381 retires it: the
   * gate is the prebuffer ceiling for this band exactly as for every other, so
   * the segment survives on the PRE side — not merely because it extends past
   * the trigger, but because the whole ceiling is in front of it.
   */
  it('a retired explicit preBufferSec: 0 no longer narrows anything, and keeps its segment', () => {
    const T = wed1000.getTime()
    const band: RecordingBand = {
      days: [],
      start: '00:00',
      end: '23:59',
      mode: 'events',
      triggers: { motion: true },
      postBufferSec: 30,
      // The narrowest cap an operator could once express. Retired (D381): the
      // keep gate does not read it, so it cannot delete the history the broker
      // handed the writer.
      preBufferSec: 0,
    }
    const triggers = recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T, 30_000).state
    const attach: AttachWindow = { attachedAtMs: T, segmentSeconds: 10 }
    // A segment whose media begins at the very edge of the widest history the
    // broker can serve — the exact media a `preBufferSec: 0` would have deleted.
    expect(segmentRetainedForEvents(T - PREBUFFER_MAX_MS, T + 10_000, band, triggers, attach)).toBe(
      true,
    )
  })
})

/**
 * THE BUS IS NOT THE AUTHORITY (D8/D11).
 *
 * `onTrigger` is the fast path and it is an EVENT — telemetry, droppable by
 * contract. When one is lost or arrives after its own window closed, the keep
 * gate has no record that the episode happened and every segment of it is
 * unlinked: footage lost for ever, which is durable state, which is exactly the
 * case D8 says must not rest on an event alone. `foldDurableTriggers` is the
 * RPC reconcile: the same windows, rebuilt from the durable motion rows.
 */
describe('foldDurableTriggers — the reconcile that the bus cannot lose', () => {
  const T = wed1000.getTime()
  const POST = 30_000

  it('rebuilds a window the bus never delivered', () => {
    const { state, recovered } = foldDurableTriggers(EMPTY_TRIGGER_STATE, MOTION, [T], POST)
    expect(recovered).toBe(1)
    expect(triggerWindowsFor(state, MOTION)).toEqual([{ firstMs: T, lastMs: T }])
  })

  it('is IDEMPOTENT — a row the fast path already recorded recovers nothing', () => {
    const live = recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T, POST).state
    const { state, recovered } = foldDurableTriggers(live, MOTION, [T], POST)
    expect(recovered).toBe(0)
    expect(state).toBe(live)
  })

  it('widens an episode whose EARLIEST rows were dropped', () => {
    // The bus delivered the tail of the episode only; the durable rows carry
    // its start, which is the edge `preBufferSec` is measured from (D191).
    const live = recordTrigger(EMPTY_TRIGGER_STATE, MOTION, T + 20_000, POST).state
    const { state, recovered } = foldDurableTriggers(live, MOTION, [T, T + 20_000], POST)
    expect(recovered).toBe(1)
    expect(triggerWindowsFor(state, MOTION)).toEqual([{ firstMs: T, lastMs: T + 20_000 }])
  })

  it('merges rows of ONE episode into one window, not one window per row', () => {
    const rows = [T, T + 5_000, T + 10_000, T + 15_000]
    const { state } = foldDurableTriggers(EMPTY_TRIGGER_STATE, MOTION, rows, POST)
    expect(triggerWindowsFor(state, MOTION)).toEqual([{ firstMs: T, lastMs: T + 15_000 }])
  })

  it('keeps two distinct episodes apart', () => {
    const rows = [T, T + POST + 60_000]
    const { state } = foldDurableTriggers(EMPTY_TRIGGER_STATE, MOTION, rows, POST)
    expect(triggerWindowsFor(state, MOTION).length).toBe(2)
  })

  it('is order-independent — a store returning newest-first folds the same', () => {
    const rows = [T + 15_000, T + 5_000, T, T + 10_000]
    const { state } = foldDurableTriggers(EMPTY_TRIGGER_STATE, MOTION, rows, POST)
    expect(triggerWindowsFor(state, MOTION)).toEqual([{ firstMs: T, lastMs: T + 15_000 }])
  })

  it('ignores rows that are not finite timestamps rather than opening a window at NaN', () => {
    const { state, recovered } = foldDurableTriggers(
      EMPTY_TRIGGER_STATE,
      MOTION,
      [Number.NaN, 0, -1],
      POST,
    )
    expect(recovered).toBe(0)
    expect(state).toBe(EMPTY_TRIGGER_STATE)
  })

  it('stays bounded — a burst of rows cannot outgrow MAX_TRIGGER_WINDOWS', () => {
    const rows = Array.from({ length: 200 }, (_, i) => T + i * (POST + 10_000))
    const { state, evicted } = foldDurableTriggers(EMPTY_TRIGGER_STATE, MOTION, rows, POST)
    expect(triggerWindowsFor(state, MOTION).length).toBeLessThanOrEqual(MAX_TRIGGER_WINDOWS)
    expect(evicted).toBeGreaterThan(0)
  })
})

/**
 * A durable row OLDER than the live window is inserted in time order (D194,
 * amended 2026-09-28).
 *
 * Camera 3836: the analyzer's row for an episode landed ~31 s before the bus
 * trigger the recorder had already opened a window for. `recordTrigger`
 * compared it with the newest window only and APPENDED it, so the newest
 * trigger went BACKWARDS: the live gate read `latestTriggerMs` from the last
 * element and tore the writer down on that very reconcile beat (a 2–9 s hole,
 * respawned by the next keepalive), and every later row in the batch diffed
 * against the wrong "newest" — `recovered` came out equal to `rows`, so the
 * log blamed a bus that had delivered everything on time.
 */
describe('trigger history stays in time order — a late row never rewinds the live gate', () => {
  const T = wed1000.getTime()
  const POST = 30_000
  const band: RecordingBand = { ...eventsBand({ motion: true }), postBufferSec: POST / 1000 }
  const config = cfg({ bands: [band] })

  /** A live episode the bus delivered: triggers every 5 s over `[from, to]`. */
  const liveEpisode = (state: TriggerState, from: number, to: number): TriggerState => {
    let next = state
    for (let at = from; at <= to; at += 5_000) next = recordTrigger(next, MOTION, at, POST).state
    return next
  }

  it('a row at T−31 s against a live window [T, T+40 s] keeps recording', () => {
    const live = liveEpisode(EMPTY_TRIGGER_STATE, T, T + 40_000)
    const { state } = foldDurableTriggers(live, MOTION, [T - 31_000], POST)

    expect(latestTriggerMs(state, MOTION)).toBe(T + 40_000)
    expect(shouldRecordAt(config, state, new Date(T + 50_000))).toBe(true)
    // The recovered episode is still there for the KEEP gate — before the live one.
    expect(triggerWindowsFor(state, MOTION)).toEqual([
      { firstMs: T - 31_000, lastMs: T - 31_000 },
      { firstMs: T, lastMs: T + 40_000 },
    ])
  })

  it('recovered counts only rows the bus had NOT delivered', () => {
    // Two bus episodes; the store answers with both of their rows plus one
    // genuinely earlier episode.
    const live = liveEpisode(liveEpisode(EMPTY_TRIGGER_STATE, T, T), T + 100_000, T + 100_000)
    const { state, recovered } = foldDurableTriggers(
      live,
      MOTION,
      [T - 31_000, T, T + 100_000],
      POST,
    )
    expect(recovered).toBe(1)
    expect(latestTriggerMs(state, MOTION)).toBe(T + 100_000)
  })

  it('any arrival order yields sorted windows, each its own episode, and the same history', () => {
    // A deterministic shuffle of 40 triggers spread over several episodes.
    const times = Array.from({ length: 40 }, (_, i) => T + ((i * 7_919) % 40) * 9_000)
    let shuffled = EMPTY_TRIGGER_STATE
    for (const at of times) shuffled = recordTrigger(shuffled, MOTION, at, POST).state
    let sorted = EMPTY_TRIGGER_STATE
    for (const at of times.toSorted((a, b) => a - b)) {
      sorted = recordTrigger(sorted, MOTION, at, POST).state
    }
    const windows = triggerWindowsFor(shuffled, MOTION)
    for (const [i, w] of windows.entries()) {
      expect(w.firstMs).toBeLessThanOrEqual(w.lastMs)
      const prev = windows[i - 1]
      if (prev !== undefined) expect(w.firstMs - prev.lastMs).toBeGreaterThan(POST)
    }
    expect(windows).toEqual(triggerWindowsFor(sorted, MOTION))
    expect(latestTriggerMs(shuffled, MOTION)).toBe(Math.max(...times))
  })

  it('a row between two episodes within the gap of both bridges them into one', () => {
    const two = liveEpisode(liveEpisode(EMPTY_TRIGGER_STATE, T, T), T + 50_000, T + 50_000)
    const bridged = recordTrigger(two, MOTION, T + 25_000, POST).state
    expect(triggerWindowsFor(bridged, MOTION)).toEqual([{ firstMs: T, lastMs: T + 50_000 }])
  })

  it('a released level span older than the newest episode is its own window, before it', () => {
    const live = liveEpisode(EMPTY_TRIGGER_STATE, T, T + 10_000)
    const held = holdTrigger(live, MOTION, T - 100_000)
    const released = releaseTrigger(held, MOTION, T - 60_000, POST)
    expect(triggerWindowsFor(released, MOTION)).toEqual([
      { firstMs: T - 100_000, lastMs: T - 60_000 },
      { firstMs: T, lastMs: T + 10_000 },
    ])
    expect(latestTriggerMs(released, MOTION)).toBe(T + 10_000)
  })

  it('a row inserted and evicted in the same fold is NOT a recovery', () => {
    // At the hard bound, a row older than every window goes in at the front and
    // straight back out: the history is unchanged, so nothing was recovered.
    let full = EMPTY_TRIGGER_STATE
    for (let i = 0; i < MAX_TRIGGER_WINDOWS; i++) {
      full = recordTrigger(full, MOTION, T + i * (POST + 1_000), POST).state
    }
    const { state, recovered, evicted } = foldDurableTriggers(full, MOTION, [T - 60_000], POST)
    expect(evicted).toBe(1)
    expect(recovered).toBe(0)
    expect(triggerWindowsFor(state, MOTION)).toEqual(triggerWindowsFor(full, MOTION))
  })

  it('latestTriggerMs is the maximum even over a list an older build left out of order', () => {
    const outOfOrder = motionState([
      { firstMs: T, lastMs: T + 40_000 },
      { firstMs: T - 31_000, lastMs: T - 31_000 },
    ])
    expect(latestTriggerMs(outOfOrder, MOTION)).toBe(T + 40_000)
  })
})

/**
 * Track A1 — `TriggerState` becomes KEYED.
 *
 * It was `{ motion: [], audio: [] }`. Two of the four sources are
 * PARAMETRIC (one window per macro class, one per source device), and a
 * single bucket per source would make the "people only" band record on every
 * passing car: the live gate and the retention gate would read a
 * signal the band never asked for.
 */
describe('keyed TriggerState', () => {
  const person: TriggerSource = { kind: 'object', macroClass: 'person' }
  const vehicle: TriggerSource = { kind: 'object', macroClass: 'vehicle' }
  const sensor42: TriggerSource = { kind: 'sensor', sourceDeviceId: 42 }

  it('separates two macro classes: a person does not open the vehicles window', () => {
    const { state } = recordTrigger(EMPTY_TRIGGER_STATE, person, 1_000, 30_000)
    expect(latestTriggerMs(state, person)).toBe(1_000)
    expect(latestTriggerMs(state, vehicle)).toBeNull()
  })

  it('separates two sensors on the same camera', () => {
    const a = recordTrigger(EMPTY_TRIGGER_STATE, sensor42, 1_000, 30_000).state
    expect(latestTriggerMs(a, { kind: 'sensor', sourceDeviceId: 43 })).toBeNull()
  })

  it('the key is stable and readable — it is the one that ends up in the logs', () => {
    expect(triggerKey({ kind: 'motion' })).toBe('motion')
    expect(triggerKey({ kind: 'audio' })).toBe('audio')
    expect(triggerKey(person)).toBe('object:person')
    expect(triggerKey(sensor42)).toBe('sensor:42')
  })

  it('pruning REMOVES the emptied key, it does not leave an empty array', () => {
    // This is what bounds the map: a sensor removed from the band stops
    // occupying a key instead of staying at length zero forever.
    const { state } = recordTrigger(EMPTY_TRIGGER_STATE, sensor42, 1_000, 30_000)
    const pruned = pruneTriggerHistory(
      state,
      30_000,
      1_000 + 30_000 + TRIGGER_HISTORY_MARGIN_MS + 1,
    )
    expect(latestTriggerMs(pruned, sensor42)).toBeNull()
    expect(pruned.windows.size).toBe(0)
  })

  it('returns the SAME object when nothing has expired', () => {
    const { state } = recordTrigger(EMPTY_TRIGGER_STATE, person, 1_000, 30_000)
    expect(pruneTriggerHistory(state, 30_000, 1_100)).toBe(state)
  })
})
