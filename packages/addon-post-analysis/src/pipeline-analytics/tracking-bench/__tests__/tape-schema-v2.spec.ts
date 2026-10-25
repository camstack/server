/**
 * Tape schema v2 (D683 §8.3): a model-free descriptor may be committed; a v1
 * tape still reads; recorded fusions replay as finalisations.
 *
 * Disarms (each alone, restored):
 *  - drop `app` from the frame-record whitelist: "a v2 frame record carries the descriptor" fails
 *    (D681's own whitelist guard fails too);
 *  - drop `app` from `tapeDetection` (the writer): "the recorder writes a detection
 *    descriptor as `app`" fails, and so does D681's whitelist key-set guard;
 *  - leave `fusion` out of `replayTape`'s control cases: "RecordedTracker reports recorded fusions" fails.
 */
import { APPEARANCE_BIN_COUNT } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildFrameRecord } from '../recorder/frame-record.js'
import { FRAME, FULL, faces, OBSERVATION } from '../recorder/__tests__/frame-record-fixtures.js'
import { replayTape } from '../replay.js'
import { decodeTapeText } from '../tape-codec.js'
import { TapeLiveSchema } from '../tape-schema.js'
import { RecordedTracker } from '../trackers/recorded-tracker.js'
import { sampleEnd, sampleHeader } from './tape-fixtures.js'

const line = (record: unknown): string => JSON.stringify(record)

describe('tape schema v2', () => {
  it('a v1 tape still reads, upcast to v2', () => {
    const text = [line({ ...sampleHeader(), version: 1 }), line(sampleEnd())].join('\n')
    expect(decodeTapeText(text).header.version).toBe(2)
  })

  // fix round 1, L5: the writer stopped spreading `rs` onto `live[]` entries
  // (D683 Task 21 — the old tracker's resurrection scenes go with it), but the
  // READER must still accept it: a v1/early-v2 tape committed before that
  // change carries `rs` on its recorded `live[]` entries, and replaying it
  // must not throw on a field the schema itself still declares optional.
  it('a v1 live entry carrying `rs` still parses, field by field', () => {
    const live = TapeLiveSchema.parse({
      trk: 't1',
      det: 'd1',
      m: true,
      st: 'moving',
      rs: 'multi-subject',
    })
    expect(live.rs).toBe('multi-subject')
  })

  it("an old tape's frame record with a `rs`-bearing live entry still decodes", () => {
    const frame = {
      kind: 'frame',
      t: 0,
      plane: 'pipeline',
      w: 640,
      h: 360,
      dets: [{ id: 'd1', k: 'first-level', cls: 'person', s: 0.9, b: [1, 2, 3, 4], src: 'frame' }],
      disc: [],
      inj: [],
      live: [{ trk: 't1', det: 'd1', m: true, st: 'moving', rs: 'sole-subject-veto-lifted' }],
    }
    const tape = decodeTapeText([line(sampleHeader()), line(frame), line(sampleEnd())].join('\n'))
    const body = tape.body[0]
    expect(body?.kind === 'frame' ? body.live[0]?.rs : undefined).toBe('sole-subject-veto-lifted')
  })

  it('a v2 frame record carries the descriptor', () => {
    const app = { v: 1, b: new Array<number>(APPEARANCE_BIN_COUNT).fill(2), g: false }
    const frame = {
      kind: 'frame',
      t: 0,
      plane: 'pipeline',
      w: 640,
      h: 360,
      dets: [
        { id: 'd1', k: 'first-level', cls: 'person', s: 0.9, b: [1, 2, 3, 4], src: 'frame', app },
      ],
      disc: [],
      inj: [],
      live: [{ trk: 't1', det: 'd1', m: true, st: 'idle' }],
    }
    const tape = decodeTapeText([line(sampleHeader()), line(frame), line(sampleEnd())].join('\n'))
    const body = tape.body[0]
    expect(body?.kind === 'frame' ? body.dets[0]?.app : undefined).toEqual(app)
  })

  it('the recorder writes a detection descriptor as `app`, bins verbatim', () => {
    const record = buildFrameRecord({
      t: 0,
      plane: 'pipeline',
      frame: FRAME,
      injectedIds: new Set(),
      observation: OBSERVATION,
      faces,
    })
    expect(record.dets[FRAME.detections.indexOf(FULL)]?.app).toEqual({
      v: 1,
      b: [...FULL.appearance.bins],
      g: false,
    })
  })

  it('RecordedTracker reports recorded fusions as finalisations, through the replay', () => {
    const fusion = {
      kind: 'fusion',
      t: 5000,
      plane: 'pipeline',
      survivor: 't1',
      absorbed: 't2',
      members: ['t2', 't3'],
    }
    const tape = decodeTapeText([line(sampleHeader()), line(fusion), line(sampleEnd())].join('\n'))
    const replay = replayTape(tape, new RecordedTracker(), 'pipeline')
    expect(replay.finalisations).toEqual([
      { provisionalId: 't2', finalId: 't1', t: 5000 },
      { provisionalId: 't3', finalId: 't1', t: 5000 },
    ])
  })
})
