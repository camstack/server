/**
 * The tape recorder asks the processor for an OBSERVATION: the gate's outcome
 * by detection id and the detection→track bindings. The moratorium (decision 6)
 * forbids that from changing anything the tracker does. This is the proof the
 * spec asks for (§7.1): the same frames through two processors, one observing
 * and one not, give the same result in every field but `observation`.
 *
 * The gate here is scripted and stateless — it suppresses the detection whose
 * id is `parked-*` (strong hold) and passes `weak-*` continuation-only — so the
 * gate path, the continuation path and the ordinary path all run.
 *
 * Disarm: in `process`, when `input.observe === true`, pass an EMPTY
 * `continuationOnly` set to `this.tracker.update` — the equality test must
 * fail. Restore.
 *
 * The second block pins the two fields a tape records that the scene above
 * never reaches, and the strong-hold entry join:
 *  - `gate.woken` — disarm: `woken: []` in `observeFrame`; its test must fail.
 *  - `live[].heldByLowScore` — disarm: `heldByLowScore: new Set()` in the
 *    observe branch of `process`; its test must fail.
 *  - `entryId` names only an UNAMBIGUOUS strong holder — disarm: drop the
 *    `c.strong` filter or the single-holder check; the ambiguity test fails.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  FrameProcessor,
  type FrameProcessorResult,
  type StationaryFrameGate,
} from '../frame-processor.js'
import type { StationaryConfirmation, StationaryWake } from '../stationary/stationary-match.js'
import { sequentialTrackIdMinter } from '../track-id.js'

function det(id: string, cls: string, x: number, w = 60, h = 160): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: cls,
    score: 0.85,
    labels: [],
    bbox: { x, y: 300, width: w, height: h },
  }
}

function frame(i: number): FrameResult {
  const t = 10_000 + i * 140
  return {
    kind: 'frame',
    frameId: `f-${String(i)}`,
    deviceId: 102,
    timestamp: t,
    width: 1280,
    height: 720,
    detections: [
      det(`walker-${String(i)}`, 'person', 100 + i * 6),
      det(`parked-${String(i)}`, 'vehicle', 800, 220, 120),
      det(`weak-${String(i)}`, 'vehicle', 600 + i * 3, 200, 110),
    ],
  }
}

const seenDetectionIds: (readonly (string | undefined)[])[] = []

const scriptedGate: StationaryFrameGate = {
  filter(input) {
    const ids = input.detectionIds ?? []
    seenDetectionIds.push(ids)
    const suppressed = new Set<number>()
    const continuable = new Set<number>()
    const confirmed: StationaryConfirmation[] = []
    ids.forEach((id, i) => {
      const d = input.detections[i]
      if (id === undefined || d === undefined) return
      if (id.startsWith('parked-')) {
        suppressed.add(i)
        confirmed.push({
          entryId: 'entry-1',
          className: 'vehicle',
          bbox: d.bbox,
          observedBbox: d.bbox,
          strong: true,
        })
      }
      if (id.startsWith('weak-')) {
        suppressed.add(i)
        continuable.add(i)
      }
    })
    return { suppressedIndices: suppressed, continuableIndices: continuable, confirmed, woken: [] }
  },
}

function processor(): FrameProcessor {
  const p = new FrameProcessor(102, { minHits: 2 }, {}, {}, 'pipeline', {
    mintTrackId: sequentialTrackIdMinter(),
  })
  p.setStationaryGate(scriptedGate)
  return p
}

function withoutObservation(r: FrameProcessorResult): FrameProcessorResult {
  const { observation: _dropped, ...rest } = r
  return rest
}

describe('processor observation', () => {
  it('changes nothing the tracker does — every field but `observation` is identical', () => {
    const observing = processor()
    const plain = processor()
    for (let i = 0; i < 30; i += 1) {
      const f = frame(i)
      const a = observing.process({ timestamp: f.timestamp, frame: f, observe: true })
      const b = plain.process({ timestamp: f.timestamp, frame: f })
      expect(withoutObservation(a)).toEqual(b)
      expect(b.observation).toBeUndefined()
      expect(a.observation).toBeDefined()
    }
  })

  it('reports the gate by detection id, with the entry a strong hold confirmed', () => {
    const p = processor()
    const f = frame(0)
    const r = p.process({ timestamp: f.timestamp, frame: f, observe: true })
    expect(r.observation?.gate.strong).toEqual([{ detectionId: 'parked-0', entryId: 'entry-1' }])
    expect(r.observation?.gate.weak).toEqual(['weak-0'])
    expect(r.observation?.gate.confirmed).toEqual(['entry-1'])
  })

  it('reports each emitted track with the detection it bound', () => {
    const p = processor()
    let last: FrameProcessorResult | undefined
    for (let i = 0; i < 4; i += 1) {
      const f = frame(i)
      last = p.process({ timestamp: f.timestamp, frame: f, observe: true })
    }
    const walker = last?.observation?.live.find((l) => l.detectionId === 'walker-3')
    expect(walker?.matched).toBe(true)
    expect(walker?.trackId).toMatch(/^t\d+$/)
  })

  it('hands the gate the detection ids aligned with its detections', () => {
    seenDetectionIds.length = 0
    const p = processor()
    const f = frame(5)
    p.process({ timestamp: f.timestamp, frame: f })
    expect(seenDetectionIds[0]).toEqual(['walker-5', 'parked-5', 'weak-5'])
  })
})

/** A walker and nothing else — the scene the low-score and wake tests share. */
function walkerFrame(i: number, discarded?: FrameResult['discarded']): FrameResult {
  const t = 20_000 + i * 140
  return {
    kind: 'frame',
    frameId: `w-${String(i)}`,
    deviceId: 102,
    timestamp: t,
    width: 1280,
    height: 720,
    detections: discarded === undefined ? [det(`walker-${String(i)}`, 'person', 100 + i * 6)] : [],
    ...(discarded !== undefined ? { discarded } : {}),
  }
}

/** The walker at frame `i`, read below the operator's floor. */
function lowWalker(i: number): NonNullable<FrameResult['discarded']> {
  const x = 100 + i * 6
  return [
    { bbox: [x, 300, x + 60, 460], macroClass: 'person', score: 0.5, reason: 'below-threshold' },
  ]
}

/** Answers every frame with the scripted outcome for the ids it is shown. */
interface ScriptedOutcome {
  readonly confirmedFor: (
    id: string,
    box: StationaryConfirmation['bbox'],
  ) => readonly StationaryConfirmation[]
  readonly woken: readonly StationaryWake[]
}

function gateOf(outcome: ScriptedOutcome): StationaryFrameGate {
  return {
    filter(input) {
      const suppressed = new Set<number>()
      const confirmed: StationaryConfirmation[] = []
      ;(input.detectionIds ?? []).forEach((id, i) => {
        const d = input.detections[i]
        if (id === undefined || d === undefined) return
        const holders = outcome.confirmedFor(id, d.bbox)
        if (holders.length === 0) return
        suppressed.add(i)
        confirmed.push(...holders)
      })
      return {
        suppressedIndices: suppressed,
        continuableIndices: new Set<number>(),
        confirmed,
        woken: outcome.woken,
      }
    },
  }
}

function processorWith(gate: StationaryFrameGate): FrameProcessor {
  const p = new FrameProcessor(102, { minHits: 2 }, {}, {}, 'pipeline', {
    mintTrackId: sequentialTrackIdMinter(),
  })
  p.setStationaryGate(gate)
  return p
}

const NO_HOLDS: ScriptedOutcome = { confirmedFor: () => [], woken: [] }

function hold(
  entryId: string,
  box: StationaryConfirmation['bbox'],
  strong: boolean,
): StationaryConfirmation {
  return { entryId, className: 'vehicle', bbox: box, observedBbox: box, strong }
}

describe('processor observation — the fields the first scene never reaches', () => {
  it('records an entry the gate woke', () => {
    const wake: StationaryWake = {
      entryId: 'entry-9',
      cause: 'sustained-absence',
      strikeAgeMs: 4_000,
      absentReads: 12,
    }
    const p = processorWith(gateOf({ confirmedFor: () => [], woken: [wake] }))
    const f = walkerFrame(0)
    const r = p.process({ timestamp: f.timestamp, frame: f, observe: true })
    expect(r.observation?.gate.woken).toEqual(['entry-9'])
  })

  it('records a live track held by a low-score box, and stays observational doing it', () => {
    const observing = processorWith(gateOf(NO_HOLDS))
    const plain = processorWith(gateOf(NO_HOLDS))
    const frames = [
      ...Array.from({ length: 6 }, (_, i) => walkerFrame(i)),
      ...Array.from({ length: 4 }, (_, k) => walkerFrame(6 + k, lowWalker(6 + k))),
    ]
    let held: readonly (true | undefined)[] = []
    for (const f of frames) {
      const a = observing.process({ timestamp: f.timestamp, frame: f, observe: true })
      const b = plain.process({ timestamp: f.timestamp, frame: f })
      expect(withoutObservation(a)).toEqual(b)
      held = (a.observation?.live ?? []).map((l) => l.heldByLowScore)
    }
    // The last frame carried only the sub-floor read: the walker's track is
    // emitted coasting, held by it.
    expect(held).toEqual([true])
  })

  it('names the entry of a strong hold only when exactly one strong holder matches the box', () => {
    // A weak holder sharing the box does not make the strong one ambiguous.
    const strongPlusWeak: ScriptedOutcome = {
      confirmedFor: (id, box) =>
        id.startsWith('walker-')
          ? [hold('entry-weak', box, false), hold('entry-strong', box, true)]
          : [],
      woken: [],
    }
    // Two strong holders of one box: the gate cannot say which, so neither is named.
    const twoStrong: ScriptedOutcome = {
      confirmedFor: (id, box) =>
        id.startsWith('walker-') ? [hold('entry-a', box, true), hold('entry-b', box, true)] : [],
      woken: [],
    }
    const f = walkerFrame(0)
    const unambiguous = processorWith(gateOf(strongPlusWeak)).process({
      timestamp: f.timestamp,
      frame: f,
      observe: true,
    })
    expect(unambiguous.observation?.gate.strong).toEqual([
      { detectionId: 'walker-0', entryId: 'entry-strong' },
    ])
    const ambiguous = processorWith(gateOf(twoStrong)).process({
      timestamp: f.timestamp,
      frame: f,
      observe: true,
    })
    expect(ambiguous.observation?.gate.strong).toEqual([{ detectionId: 'walker-0' }])
    expect(ambiguous.observation?.gate.confirmed).toEqual(['entry-a', 'entry-b'])
  })
})
