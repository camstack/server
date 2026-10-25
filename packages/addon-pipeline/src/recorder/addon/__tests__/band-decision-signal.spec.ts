/**
 * THE DEVICE SIGNAL IS A LEVEL, NOT AN EDGE.
 *
 * Every other source folds a TIMESTAMP into the history and the live gate
 * asks "was one within `postBufferSec` of now". A camera's own
 * `recording-signal` says "still happening" for as long as it is raised —
 * forty minutes of cleaning — and nothing re-emits it on a timer. So the
 * history HOLDS the source open from the instant it rose, the live gate says
 * yes for as long as it is held, and the release turns the hold into an
 * ordinary window `[since, fell]` that the post-buffer and the keep gate then
 * treat exactly like a motion episode.
 */
import { describe, expect, it } from 'vitest'
import type { RecordingConfig } from '@camstack/types'
import {
  bandTriggerSources,
  DEVICE_DECISION_BAND,
  effectiveBands,
  type EffectiveBand,
  EMPTY_TRIGGER_STATE,
  eventsBandCanEverDemand,
  heldSinceMs,
  holdTrigger,
  latestTriggerMs,
  pruneTriggerHistory,
  releaseTrigger,
  segmentMissedByMs,
  segmentRetainedForEvents,
  shouldRecordAt,
  TRIGGER_KEY_TO_SOURCE_KIND,
  triggerKey,
  triggerWindowsFor,
  type TriggerSource,
} from '../band-decision.js'
import { eventsWindowCloseMs, nextDecisionChangeAt } from '../decision-schedule.js'

const SIGNAL: TriggerSource = { kind: 'signal' }
const MOTION: TriggerSource = { kind: 'motion' }
const POST_SEC = 30
const PRE_SEC = 15

/** The band the DEVICE-decided mode resolves to — never authored, produced by
 *  `effectiveBands` alone (D380). `PRE_SEC`/`POST_SEC` below are its own pad. */
function signalBand(): EffectiveBand {
  return DEVICE_DECISION_BAND
}

/** The D380 config: the MODE, and no bands at all. */
function cfg(band: EffectiveBand): RecordingConfig {
  if (band === DEVICE_DECISION_BAND) return { enabled: true, bands: [], deviceDecision: true }
  return { enabled: true, bands: [band] }
}

const T0 = new Date('2026-09-06T10:00:00').getTime()
const attach = { attachedAtMs: T0, segmentSeconds: 10 }

describe('the wire key and the source', () => {
  it('`deviceDecision: true` is ONE source of kind signal, keyed `signal`', () => {
    expect(bandTriggerSources(signalBand())).toEqual([SIGNAL])
    expect(triggerKey(SIGNAL)).toBe('signal')
    expect(TRIGGER_KEY_TO_SOURCE_KIND.deviceDecision).toBe('signal')
    expect(eventsBandCanEverDemand(signalBand())).toBe(true)
  })

  it('the mode resolves to exactly ONE always-on band, and a band config to its own', () => {
    expect(effectiveBands({ enabled: true, bands: [], deviceDecision: true })).toEqual([
      DEVICE_DECISION_BAND,
    ])
    const authored = { days: [], start: '00:00', end: '00:00', mode: 'continuous' as const }
    expect(effectiveBands({ enabled: true, bands: [authored] })).toEqual([authored])
  })

  it('the retired band trigger is NOT a source — a band cannot carry the signal any more', () => {
    // The wire key is gone; a stale object shaped like the old one must not
    // resurrect the source through a structural back door.
    // Pre-D380 wire shape — `RecordingTriggersSchema` strips the key on parse;
    // `bandTriggerSources` must not resurrect it from a stale blob.
    const stale: EffectiveBand = {
      days: [],
      start: '00:00',
      end: '00:00',
      mode: 'events',
      triggers: { deviceSignal: true },
    } as EffectiveBand
    expect(bandTriggerSources(stale)).toEqual([])
  })
})

describe('hold / release', () => {
  it('a hold is remembered from its rise; a second rise does NOT move it', () => {
    const held = holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0)
    expect(heldSinceMs(held, SIGNAL)).toBe(T0)
    expect(heldSinceMs(holdTrigger(held, SIGNAL, T0 + 5_000), SIGNAL)).toBe(T0)
    expect(heldSinceMs(held, MOTION)).toBeNull()
  })

  it('release turns the hold into a window [since, fell] and nothing else', () => {
    const held = holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0)
    const released = releaseTrigger(held, SIGNAL, T0 + 600_000, POST_SEC * 1000)
    expect(heldSinceMs(released, SIGNAL)).toBeNull()
    expect(triggerWindowsFor(released, SIGNAL)).toEqual([{ firstMs: T0, lastMs: T0 + 600_000 }])
    expect(latestTriggerMs(released, SIGNAL)).toBe(T0 + 600_000)
  })

  it('a release with no hold is a no-op — the same object comes back', () => {
    expect(releaseTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0, POST_SEC * 1000)).toBe(
      EMPTY_TRIGGER_STATE,
    )
  })

  it('a rise inside the post-buffer of the previous fall MERGES into that episode', () => {
    const first = releaseTrigger(
      holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0),
      SIGNAL,
      T0 + 60_000,
      POST_SEC * 1000,
    )
    const second = releaseTrigger(
      holdTrigger(first, SIGNAL, T0 + 70_000),
      SIGNAL,
      T0 + 120_000,
      POST_SEC * 1000,
    )
    expect(triggerWindowsFor(second, SIGNAL)).toEqual([{ firstMs: T0, lastMs: T0 + 120_000 }])
  })

  it('prune never drops a hold, however old', () => {
    const held = holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0)
    const pruned = pruneTriggerHistory(held, POST_SEC * 1000, T0 + 24 * 3_600_000)
    expect(heldSinceMs(pruned, SIGNAL)).toBe(T0)
  })
})

describe('the live gate', () => {
  it('demands for as long as the signal is held, and postBufferSec after the release', () => {
    const held = holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0)
    expect(shouldRecordAt(cfg(signalBand()), held, new Date(T0 + 3_600_000))).toBe(true)
    const released = releaseTrigger(held, SIGNAL, T0 + 3_600_000, POST_SEC * 1000)
    expect(
      shouldRecordAt(cfg(signalBand()), released, new Date(T0 + 3_600_000 + POST_SEC * 1000)),
    ).toBe(true)
    expect(
      shouldRecordAt(cfg(signalBand()), released, new Date(T0 + 3_600_000 + POST_SEC * 1000 + 1)),
    ).toBe(false)
  })

  it('an AUTHORED band is untouched by a hold — only the mode listens to the level', () => {
    const band: EffectiveBand = {
      days: [],
      start: '00:00',
      end: '00:00',
      mode: 'events',
      triggers: { motion: true },
      preBufferSec: PRE_SEC,
      postBufferSec: POST_SEC,
    }
    const held = holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0)
    expect(shouldRecordAt(cfg(band), held, new Date(T0 + 1_000))).toBe(false)
  })
})

describe('the schedule', () => {
  it('a held signal has NO window-close instant — only the release can end it', () => {
    const held = holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0)
    expect(eventsWindowCloseMs(signalBand(), held, T0 + 1_000)).toBeNull()
    expect(
      nextDecisionChangeAt({ config: cfg(signalBand()), triggers: held, nowMs: T0 }),
    ).toBeNull()
  })

  it('after the release the close is armed at fell + postBufferSec, like any episode', () => {
    const fell = T0 + 100_000
    const released = releaseTrigger(
      holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0),
      SIGNAL,
      fell,
      POST_SEC * 1000,
    )
    expect(
      nextDecisionChangeAt({ config: cfg(signalBand()), triggers: released, nowMs: fell }),
    ).toEqual({
      atMs: fell + POST_SEC * 1000 + 1,
      reason: 'window-close',
    })
  })
})

describe('the keep gate', () => {
  it('a segment recorded while the signal is held is kept, with the pre-buffer before the rise', () => {
    const held = holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0)
    // Inside the hold, an hour later: no window would say yes, the hold does.
    expect(
      segmentRetainedForEvents(T0 + 3_600_000, T0 + 3_610_000, signalBand(), held, attach),
    ).toBe(true)
    // Pre-buffer: a segment ending just after `since - preBufferSec` is kept…
    expect(
      segmentRetainedForEvents(T0 - 20_000, T0 - PRE_SEC * 1000 + 1, signalBand(), held, attach),
    ).toBe(true)
    // …one ending before it is not.
    expect(
      segmentRetainedForEvents(T0 - 40_000, T0 - PRE_SEC * 1000 - 1, signalBand(), held, attach),
    ).toBe(false)
    expect(segmentMissedByMs(T0 + 3_600_000, signalBand(), held, attach)).toBeLessThan(0)
  })

  it('after the release, only the post-buffer past the fall survives', () => {
    const fell = T0 + 600_000
    const released = releaseTrigger(
      holdTrigger(EMPTY_TRIGGER_STATE, SIGNAL, T0),
      SIGNAL,
      fell,
      POST_SEC * 1000,
    )
    expect(
      segmentRetainedForEvents(
        fell + POST_SEC * 1000,
        fell + POST_SEC * 1000 + 10_000,
        signalBand(),
        released,
        attach,
      ),
    ).toBe(true)
    expect(
      segmentRetainedForEvents(
        fell + POST_SEC * 1000 + 1,
        fell + POST_SEC * 1000 + 10_000,
        signalBand(),
        released,
        attach,
      ),
    ).toBe(false)
  })
})
