/**
 * The arithmetic behind the recorder's event-driven wake-ups.
 *
 * `nextDecisionChangeAt` answers the ONE question the convergence loop used to
 * answer by polling every 30 s: at what instant could `shouldRecordAt` return a
 * different answer than it does right now? Two sources, and only two:
 *
 *  - an `events` band's demand window closing (`lastTrigger + postBufferSec`),
 *  - a band edge — a wall-clock instant, known in advance from the band model.
 *
 * These tests pin the arithmetic against the SAME band engine the live gate
 * uses (`activeBandAt`), because the whole point is that the timer and the gate
 * cannot disagree: a wake-up that fires when the decision has NOT changed is a
 * wasted turn, and one that never fires is lost footage (or a camera pulled
 * long past its window).
 *
 * Every instant here is built with local-calendar `Date` constructors, exactly
 * as `bandActiveAt` reads them (`getDay()`/`getHours()`), so the suite is
 * timezone-independent.
 */
import type { RecordingConfig } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  GATE_INCLUSIVE_EPSILON_MS,
  nextBandEdgeMs,
  nextDecisionChangeAt,
} from '../decision-schedule'
import {
  EMPTY_TRIGGER_STATE,
  triggerKey,
  type TriggerSource,
  type TriggerState,
  type TriggerWindow,
} from '../band-decision.js'

/** Local noon on a Tuesday (2026-08-18 is a Tuesday). */
function localAt(hour: number, minute = 0, dayOfMonth = 18): number {
  return new Date(2026, 7, dayOfMonth, hour, minute, 0, 0).getTime()
}

const NO_TRIGGERS: TriggerState = EMPTY_TRIGGER_STATE

const MOTION: TriggerSource = { kind: 'motion' }
const AUDIO: TriggerSource = { kind: 'audio' }

/**
 * Build a `TriggerState` from explicit windows — the shape these tests wrote as
 * `{ motion: [...], audio: [...] }` before the state became KEYED (Track A1).
 * Mechanical port; every assertion below is unchanged.
 */
const triggerStateOf = (
  entries: readonly (readonly [TriggerSource, readonly TriggerWindow[]])[],
): TriggerState => ({
  windows: new Map(
    entries.filter(([, w]) => w.length > 0).map(([src, w]) => [triggerKey(src), w] as const),
  ),
})

/** An always-covering band: `start === end` + empty `days` => active at every instant. */
const ALWAYS = { days: [] as number[], start: '00:00', end: '00:00' }

describe('nextDecisionChangeAt — nothing can ever change', () => {
  it('returns null for a disabled config (no band edge matters while off)', () => {
    const config: RecordingConfig = {
      enabled: false,
      bands: [{ ...ALWAYS, mode: 'continuous' }],
    }
    expect(nextDecisionChangeAt({ config, triggers: NO_TRIGGERS, nowMs: localAt(12) })).toBeNull()
  })

  it('returns null for an enabled config with no bands', () => {
    const config: RecordingConfig = { enabled: true, bands: [] }
    expect(nextDecisionChangeAt({ config, triggers: NO_TRIGGERS, nowMs: localAt(12) })).toBeNull()
  })

  it('returns null for a single always-on continuous band — there is no edge, ever', () => {
    const config: RecordingConfig = {
      enabled: true,
      bands: [{ ...ALWAYS, mode: 'continuous' }],
    }
    expect(nextDecisionChangeAt({ config, triggers: NO_TRIGGERS, nowMs: localAt(12) })).toBeNull()
  })

  it('returns null for an always-on events band with no trigger yet — only a trigger can change it', () => {
    const config: RecordingConfig = {
      enabled: true,
      bands: [{ ...ALWAYS, mode: 'events', triggers: { motion: true }, postBufferSec: 30 }],
    }
    expect(nextDecisionChangeAt({ config, triggers: NO_TRIGGERS, nowMs: localAt(12) })).toBeNull()
  })
})

describe('nextDecisionChangeAt — an events window closing', () => {
  const config: RecordingConfig = {
    enabled: true,
    bands: [{ ...ALWAYS, mode: 'events', triggers: { motion: true }, postBufferSec: 30 }],
  }

  it('arms one millisecond PAST `trigger + postBufferSec` — the live gate is inclusive', () => {
    const trigger = localAt(12)
    const next = nextDecisionChangeAt({
      config,
      triggers: triggerStateOf([[MOTION, [{ firstMs: trigger, lastMs: trigger }]]]),
      nowMs: trigger,
    })
    // Literal, NOT `+ GATE_INCLUSIVE_EPSILON_MS`: an assertion written against
    // the constant it is testing passes for every value the constant could
    // take, including the `0` that would arm a wake-up at an instant the gate
    // still calls "recording".
    expect(next).toEqual({ atMs: trigger + 30_000 + 1, reason: 'window-close' })
    expect(GATE_INCLUSIVE_EPSILON_MS).toBe(1)
  })

  it('takes the LATEST open window when the band listens for two trigger kinds (demand is an OR)', () => {
    const both: RecordingConfig = {
      enabled: true,
      bands: [
        {
          ...ALWAYS,
          mode: 'events',
          triggers: { motion: true, audioThresholdDbfs: -40 },
          postBufferSec: 30,
        },
      ],
    }
    const trigger = localAt(12)
    const next = nextDecisionChangeAt({
      config: both,
      triggers: triggerStateOf([
        [MOTION, [{ firstMs: trigger, lastMs: trigger }]],
        [AUDIO, [{ firstMs: trigger + 5_000, lastMs: trigger + 5_000 }]],
      ]),
      nowMs: trigger + 5_000,
    })
    expect(next?.atMs).toBe(trigger + 5_000 + 30_000 + 1)
  })

  it('IGNORES a trigger kind the band does not listen for', () => {
    const trigger = localAt(12)
    const next = nextDecisionChangeAt({
      config,
      triggers: triggerStateOf([[AUDIO, [{ firstMs: trigger, lastMs: trigger }]]]),
      nowMs: trigger,
    })
    expect(next).toBeNull()
  })

  it('returns null once the window has already closed — the decision cannot change again on its own', () => {
    const trigger = localAt(12)
    const next = nextDecisionChangeAt({
      config,
      triggers: triggerStateOf([[MOTION, [{ firstMs: trigger, lastMs: trigger }]]]),
      nowMs: trigger + 30_001,
    })
    expect(next).toBeNull()
  })

  it('uses the DEFAULT post-buffer when the band omits it (an absent field is not a zero)', () => {
    const omitted: RecordingConfig = {
      enabled: true,
      bands: [{ ...ALWAYS, mode: 'events', triggers: { motion: true } }],
    }
    const trigger = localAt(12)
    const next = nextDecisionChangeAt({
      config: omitted,
      triggers: triggerStateOf([[MOTION, [{ firstMs: trigger, lastMs: trigger }]]]),
      nowMs: trigger,
    })
    // DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec === 30
    expect(next?.atMs).toBe(trigger + 30_000 + 1)
  })
})

describe('nextBandEdgeMs — a wall-clock instant known in advance', () => {
  it('finds the END of the band covering now', () => {
    const config: RecordingConfig = {
      enabled: true,
      bands: [{ days: [], start: '08:00', end: '18:00', mode: 'continuous' }],
    }
    expect(nextBandEdgeMs(config, localAt(12))).toBe(localAt(18))
  })

  it('finds TOMORROW’s start when now is past the band', () => {
    const config: RecordingConfig = {
      enabled: true,
      bands: [{ days: [], start: '08:00', end: '18:00', mode: 'continuous' }],
    }
    expect(nextBandEdgeMs(config, localAt(20))).toBe(localAt(8, 0, 19))
  })

  it('handles a band that wraps past midnight', () => {
    const config: RecordingConfig = {
      enabled: true,
      bands: [{ days: [], start: '22:00', end: '06:00', mode: 'continuous' }],
    }
    expect(nextBandEdgeMs(config, localAt(23))).toBe(localAt(6, 0, 19))
  })

  it('finds the LOCAL MIDNIGHT at which a days-restricted band starts applying', () => {
    // 2026-08-18 is a Tuesday (getDay() === 2); the band covers Wednesday only.
    const config: RecordingConfig = {
      enabled: true,
      bands: [{ days: [3], start: '00:00', end: '00:00', mode: 'continuous' }],
    }
    expect(nextBandEdgeMs(config, localAt(12))).toBe(localAt(0, 0, 19))
  })

  it('finds the handover between two ADJACENT bands', () => {
    const config: RecordingConfig = {
      enabled: true,
      bands: [
        { days: [], start: '08:00', end: '18:00', mode: 'continuous' },
        { days: [], start: '18:00', end: '08:00', mode: 'events', triggers: { motion: true } },
      ],
    }
    expect(nextBandEdgeMs(config, localAt(12))).toBe(localAt(18))
  })

  it('returns null when no band edge exists inside the horizon', () => {
    const config: RecordingConfig = {
      enabled: true,
      bands: [{ ...ALWAYS, mode: 'continuous' }],
    }
    expect(nextBandEdgeMs(config, localAt(12))).toBeNull()
  })
})

describe('nextDecisionChangeAt — whichever comes FIRST', () => {
  const config: RecordingConfig = {
    enabled: true,
    bands: [
      {
        days: [],
        start: '08:00',
        end: '18:00',
        mode: 'events',
        triggers: { motion: true },
        postBufferSec: 30,
      },
    ],
  }

  it('picks the window close when it lands before the band edge', () => {
    const trigger = localAt(12)
    expect(
      nextDecisionChangeAt({
        config,
        triggers: triggerStateOf([[MOTION, [{ firstMs: trigger, lastMs: trigger }]]]),
        nowMs: trigger,
      }),
    ).toEqual({ atMs: trigger + 30_000 + 1, reason: 'window-close' })
  })

  it('picks the band edge when the window would outlive it', () => {
    // Trigger 10 s before the 18:00 edge: the window would run to 18:00:10, but
    // the band stops covering `now` at 18:00 and the decision changes there.
    const trigger = localAt(17, 59) + 50_000
    expect(
      nextDecisionChangeAt({
        config,
        triggers: triggerStateOf([[MOTION, [{ firstMs: trigger, lastMs: trigger }]]]),
        nowMs: trigger,
      }),
    ).toEqual({ atMs: localAt(18), reason: 'band-edge' })
  })
})
