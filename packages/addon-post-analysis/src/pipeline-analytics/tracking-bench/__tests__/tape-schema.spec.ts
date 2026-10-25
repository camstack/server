/**
 * The tape schema is the privacy boundary of a PUBLIC repo (§3.5, §3.6): strict
 * at every level, one version, no hour of day. What is pinned:
 *
 *  - a well-formed tape round-trips through the codec unchanged;
 *  - an unknown key anywhere is REFUSED (strict), which is what stops a field
 *    added to `FrameResult` from reaching a tape without a version bump;
 *  - `localHour` — the first draft's field, removed by decision 12 — is refused;
 *  - a version without an upcaster is refused by name;
 *  - structure: one header first, `end` only last.
 *
 * Disarm: replace `z.strictObject` with `z.object` in `TapeFrameSchema` — the
 * unknown-key test must fail.
 */
import { describe, expect, it } from 'vitest'
import { decodeTapeText, encodeTapeLine, TapeDecodeError } from '../tape-codec.js'
import { parseTapeRecord, TapeVersionError } from '../tape-schema.js'
import { sampleEnd, sampleFrame, sampleHeader } from './tape-fixtures.js'

function text(...records: readonly object[]): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join('')
}

describe('tape schema v1', () => {
  it('round-trips a header, two frames and an end through the codec', () => {
    const header = sampleHeader()
    const frames = [sampleFrame(0), sampleFrame(140)]
    const end = sampleEnd()
    const encoded = [header, ...frames, end].map((r) => encodeTapeLine(r)).join('')

    const tape = decodeTapeText(encoded)

    expect(tape.header).toEqual(header)
    expect(tape.body).toEqual(frames)
    expect(tape.end).toEqual(end)
  })

  it('refuses an unknown key on a frame — strict, so nothing rides along', () => {
    expect(() => parseTapeRecord({ ...sampleFrame(0), embedding: [0.1, 0.2] }, 1)).toThrow()
  })

  it('refuses an unknown key on a detection', () => {
    const frame = sampleFrame(0)
    const det = { ...frame.dets[0], labels: [{ label: 'Alice', score: 0.9 }] }
    expect(() => parseTapeRecord({ ...frame, dets: [det] }, 1)).toThrow()
  })

  it('refuses the hour of day on a header (decision 12)', () => {
    expect(() => parseTapeRecord({ ...sampleHeader(), localHour: 7 }, 1)).toThrow()
  })

  it('refuses a version it has no upcaster for, by name', () => {
    expect(() => parseTapeRecord(sampleFrame(0), 3)).toThrow(TapeVersionError)
  })

  it('refuses a tape whose first line is not a header', () => {
    expect(() => decodeTapeText(text(sampleFrame(0)))).toThrow(TapeDecodeError)
  })

  it('refuses a record after the end', () => {
    expect(() => decodeTapeText(text(sampleHeader(), sampleEnd(), sampleFrame(0)))).toThrow(
      TapeDecodeError,
    )
  })

  it('accepts an unfinished segment (no end yet) with end = null', () => {
    const tape = decodeTapeText(text(sampleHeader(), sampleFrame(0)))
    expect(tape.end).toBeNull()
    expect(tape.body).toHaveLength(1)
  })
})
