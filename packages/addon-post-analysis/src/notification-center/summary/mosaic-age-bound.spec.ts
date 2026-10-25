/**
 * The mosaic bound moved from a COUNT to an AGE (D485, superseding that half of
 * D480). These pin the predicate, and in particular the two readings that would
 * be catastrophic if they were ever confused: "evict everything" and "evict
 * nothing".
 */
import { describe, expect, it } from 'vitest'
import type { MediaFileRef } from '@camstack/types'
import { mosaicsToEvict } from './summary-mosaic.js'

function row(mediaId: number, timestamp: number): MediaFileRef {
  return { mediaId, timestamp } as unknown as MediaFileRef
}

const ROWS: readonly MediaFileRef[] = [row(1, 1_000), row(2, 5_000), row(3, 9_000)]

describe('mosaicsToEvict, by age', () => {
  it('evicts only what is older than the cutoff', () => {
    expect(mosaicsToEvict(ROWS, { olderThanMs: 5_000 }).map((r) => r.mediaId)).toEqual([1])
  })

  it('treats the cutoff instant itself as still inside the window', () => {
    // A row written exactly at the cutoff is not yet old. Off-by-one here
    // deletes a mosaic the digest that referenced it was still showing.
    expect(mosaicsToEvict([row(1, 5_000)], { olderThanMs: 5_000 })).toEqual([])
  })

  it('evicts nothing when there is no cutoff', () => {
    // `null` is what a configured `0` ("keep forever") resolves to. It must
    // never be read as "keep zero of them".
    expect(mosaicsToEvict(ROWS, { olderThanMs: null })).toEqual([])
  })

  it('evicts everything only when asked in those words', () => {
    // The rule was deleted: its mosaics go, whatever their age. This used to be
    // spelled `keep: 0`, one typo away from the previous case meaning the
    // opposite.
    expect(
      mosaicsToEvict(ROWS, { all: true })
        .map((r) => r.mediaId)
        .toSorted(),
    ).toEqual([1, 2, 3])
  })
})
