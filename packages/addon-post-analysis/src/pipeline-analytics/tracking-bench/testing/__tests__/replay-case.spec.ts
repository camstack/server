/**
 * The vitest helper a tracker test calls (D681; "Interface for D683" §4):
 * replay the case through a tracker and throw, naming every violation, when
 * the labels are not honoured. A deferred linker that fuses the two pieces of
 * one subject passes; the recorded live run, which split them, does not.
 *
 * Disarm: make `expectCaseHonoured` return without throwing — "throws, naming
 * the split" must fail.
 */
import { describe, expect, it } from 'vitest'
import { sampleEnd, sampleFrame, sampleHeader } from '../../__tests__/tape-fixtures.js'
import type { CaseContent } from '../../cases/case-fixture.js'
import type { Tape } from '../../tape-codec.js'
import type { TapeControlRecord, TapeFrame, TapeHeader, TapePlane } from '../../tape-schema.js'
import { RecordedTracker } from '../../trackers/recorded-tracker.js'
import type {
  TapeFinalisation,
  TapeFinalOutput,
  TapeStepOutput,
  TapeTracker,
} from '../../trackers/tape-tracker.js'
import { CaseNotHonouredError, expectCaseHonoured, replayCase } from '../replay-case.js'

function frame(t: number): TapeFrame {
  const binding: readonly [string, string] =
    t <= 200 ? [`a-${String(t)}`, 'A'] : [`b-${String(t)}`, 'B']
  const [det, trk] = binding
  return sampleFrame(t, {
    dets: [
      { id: det, k: 'first-level', cls: 'person', s: 0.9, b: [100, 0, 50, 120], src: 'frame' },
    ],
    live: [{ trk, det, m: true, st: 'moving' }],
  })
}

const TAPE: Tape = {
  header: sampleHeader(),
  body: [0, 100, 200, 300, 400].map(frame),
  end: sampleEnd({ durationMs: 400, frames: 5, reason: 'window-end' }),
}

const CASE: CaseContent = {
  manifest: {
    version: 1,
    slug: 'door-reacquired',
    deviceId: 101,
    plane: 'pipeline',
    lighting: 'day',
    status: 'held',
    recordedDate: '2026-09-29',
    importedDate: '2026-09-29',
    frames: 5,
  },
  tape: TAPE,
  gt: {
    version: 1,
    reviewed: true,
    relations: [{ a: 'A', b: 'B', relation: 'same-subject' }],
    purities: [],
    external: [],
  },
}

/** A deferred linker in miniature: the recorded ids, plus fusions at the end. */
class LinkingTracker implements TapeTracker {
  readonly name = 'linking'
  private readonly inner = new RecordedTracker()
  private readonly links: readonly TapeFinalisation[]

  constructor(links: readonly TapeFinalisation[]) {
    this.links = links
  }

  start(header: TapeHeader, plane: TapePlane): void {
    this.inner.start(header, plane)
  }

  control(record: TapeControlRecord): void {
    this.inner.control(record)
  }

  step(f: TapeFrame): TapeStepOutput {
    return this.inner.step(f)
  }

  finish(endT: number): TapeFinalOutput {
    return { finalised: this.links.map((l) => ({ ...l, t: endT })) }
  }
}

describe('expectCaseHonoured', () => {
  it('throws, naming the split, when the tracker keeps two ids for one subject', () => {
    let caught: unknown = null
    try {
      expectCaseHonoured(CASE, () => new RecordedTracker())
    } catch (err: unknown) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CaseNotHonouredError)
    if (!(caught instanceof CaseNotHonouredError)) return
    expect(caught.message).toContain('door-reacquired via recorded')
    expect(caught.message).toContain('same subject, split: A → A, B → B')
    expect(caught.report.violations).toHaveLength(1)
  })

  it('passes a tracker that fuses the two pieces', () => {
    expect(() =>
      expectCaseHonoured(
        CASE,
        () => new LinkingTracker([{ provisionalId: 'B', finalId: 'A', t: 0 }]),
      ),
    ).not.toThrow()
  })

  it('reports through replayCase without throwing', () => {
    expect(replayCase(CASE, () => new LinkingTracker([]))).toMatchObject({
      tracker: 'linking',
      checked: 1,
    })
  })
})
