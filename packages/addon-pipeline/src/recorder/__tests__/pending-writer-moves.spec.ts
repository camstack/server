/**
 * `pendingWriterMoves` — the standing disagreement between the PLAN and the
 * DISK (D387).
 *
 * Placement applies at attach boundaries only, so a re-planned camera keeps
 * its root until it next attaches. A continuously-recording camera never
 * does — its plan can name a new disk forever without one byte moving, and
 * before this the whole state was invisible.
 */
import { describe, expect, it } from 'vitest'
import { pendingMovesSignature, pendingWriterMoves } from '../addon/pending-writer-moves.js'
import type { ActiveWriterDir } from '../addon/recording-controller.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'

const OLD: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/recordings' },
  'active',
)
/** The fresh 4 TB disk. Its root is a STRING PREFIX of the old one's. */
const NEW: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:recordings-high-4tb', type: 'recordings', root: '/recordings-2' },
  'active',
)
const LOCATIONS = [OLD, NEW]

function writer(deviceId: number, root: string): ActiveWriterDir {
  return { deviceId, profile: 'high', outDir: `${root}/${String(deviceId)}/high` }
}

describe('pendingWriterMoves', () => {
  it('reports a live writer the plan wants on another disk', () => {
    const moves = pendingWriterMoves(
      [writer(102, '/recordings')],
      new Map([['102:high', 'recordings:recordings-high-4tb']]),
      LOCATIONS,
    )
    expect(moves).toEqual([
      {
        deviceId: 102,
        profile: 'high',
        writingTo: 'recordings:default',
        plannedFor: 'recordings:recordings-high-4tb',
      },
    ])
  })

  it('reports nothing when the writer is already where the plan says', () => {
    const moves = pendingWriterMoves(
      [writer(102, '/recordings-2')],
      new Map([['102:high', 'recordings:recordings-high-4tb']]),
      LOCATIONS,
    )
    expect(moves).toEqual([])
  })

  it('never matches /recordings-2 against /recordings — a prefix is not a parent', () => {
    // The whole defect this guards: a naive `startsWith` attributes the new
    // disk's writers to the old location and reports every one of them as
    // pending, forever.
    const moves = pendingWriterMoves(
      [writer(101, '/recordings-2')],
      new Map([['101:high', 'recordings:default']]),
      LOCATIONS,
    )
    expect(moves[0]?.writingTo).toBe('recordings:recordings-high-4tb')
  })

  it('a key the pass did not plan is NOT pending — a subset is not a verdict', () => {
    // `recompute` plans a work SUBSET; "absent from this plan" must never read
    // as "planned somewhere else".
    const moves = pendingWriterMoves([writer(999, '/recordings')], new Map(), LOCATIONS)
    expect(moves).toEqual([])
  })

  it('a writer under NO known root is reported, not dropped', () => {
    const moves = pendingWriterMoves(
      [writer(102, '/somewhere-else')],
      new Map([['102:high', 'recordings:default']]),
      LOCATIONS,
    )
    expect(moves[0]?.writingTo).toBeNull()
  })

  it('signs the pending set so the report is latched on WHAT is pending', () => {
    const first = pendingWriterMoves(
      [writer(102, '/recordings'), writer(101, '/recordings')],
      new Map([
        ['102:high', 'recordings:recordings-high-4tb'],
        ['101:high', 'recordings:recordings-high-4tb'],
      ]),
      LOCATIONS,
    )
    // Same set, writers enumerated the other way round: one signature.
    const second = pendingWriterMoves(
      [writer(101, '/recordings'), writer(102, '/recordings')],
      new Map([
        ['101:high', 'recordings:recordings-high-4tb'],
        ['102:high', 'recordings:recordings-high-4tb'],
      ]),
      LOCATIONS,
    )
    expect(pendingMovesSignature(first)).toBe(pendingMovesSignature(second))
    expect(pendingMovesSignature(first)).not.toBe(pendingMovesSignature(first.slice(0, 1)))
  })
})
