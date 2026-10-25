/**
 * A committed tape records the resolved settings it was built from; retiring
 * a key must not make it unreadable (spec §7, "Tapes").
 *
 * Disarms (each alone, restored):
 *  - remove the strip step from the upcaster: "read with the retired tracking keys stripped" fails;
 *  - remove the v1 drop-reason mapping (D683 Task 14 fix round 1, H1): "a v1
 *    promotion drop reads as 'dropped'" fails — the strict enum throws.
 */
import { describe, expect, it } from 'vitest'
import { decodeTapeText } from '../tape-codec.js'
import { sampleEnd, sampleHeader, sampleInputs } from './tape-fixtures.js'

describe('tapes recorded before D683', () => {
  it('read with the retired tracking keys stripped, in the header and in a processor record', () => {
    const inputs = sampleInputs()
    const legacy = {
      ...inputs,
      tracking: { ...inputs.tracking, resurrectionWindowMs: 8000, dedupMergeFrames: 5 },
    }
    // Plain JSON lines: a v1 header with retired keys is exactly what the
    // strict v2 types refuse to let a test spell, and what the READER must take.
    const lines = [
      JSON.stringify({ ...sampleHeader(), version: 1, planes: { pipeline: legacy } }),
      JSON.stringify({
        kind: 'processor',
        t: 10,
        plane: 'pipeline',
        inputs: legacy,
        reason: 'rebuilt',
      }),
      JSON.stringify(sampleEnd()),
    ]
    const tape = decodeTapeText(lines.join('\n'))
    expect(Object.keys(tape.header.planes.pipeline?.tracking ?? {})).not.toContain(
      'resurrectionWindowMs',
    )
    const rec = tape.body[0]
    expect(
      rec?.kind === 'processor' ? Object.keys(rec.inputs.tracking) : ['missing'],
    ).not.toContain('dedupMergeFrames')
  })

  it("a v1 promotion drop reads as 'dropped' — never linked, as it was live", () => {
    // Exactly what `main` wrote before round 4: every v1 promotion DISPOSED
    // the track, so it was never linked — `'dropped'` is the faithful reading.
    const lines = [
      JSON.stringify({ ...sampleHeader(), version: 1 }),
      JSON.stringify({
        kind: 'drop',
        t: 280,
        plane: 'pipeline',
        trk: 'trk-9',
        reason: 'stationary-promotion',
      }),
      JSON.stringify(sampleEnd()),
    ]
    const tape = decodeTapeText(lines.join('\n'))
    expect(tape.body[0]).toEqual({
      kind: 'drop',
      t: 280,
      plane: 'pipeline',
      trk: 'trk-9',
      reason: 'dropped',
    })
  })

  it('a v2 tape may not spell the retired reason', () => {
    const lines = [
      JSON.stringify(sampleHeader()),
      JSON.stringify({
        kind: 'drop',
        t: 280,
        plane: 'pipeline',
        trk: 'trk-9',
        reason: 'stationary-promotion',
      }),
      JSON.stringify(sampleEnd()),
    ]
    expect(() => decodeTapeText(lines.join('\n'))).toThrow()
  })
})
