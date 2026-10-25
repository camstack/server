/**
 * A location's CAPACITY is reported for every location this node can read.
 *
 * The gate was `isLocationEnabled`, written when enabled meant "we write here"
 * and skipping the statfs of a frozen disk was a cheap saving. Under the four
 * states (D385) that same reading hid the free space of a DRAINING disk — the
 * one state whose entire purpose is watching it empty. The operator drained
 * `/recordings` and the row said "Capacity unknown" while the disk sat there
 * with 1.8 TB of it, because draining is not active.
 *
 * The rule is readability, not writability: `active`, `readonly` and `drain`
 * all report; `disabled` — the state where the system does not touch the
 * location at all — reports nothing, which is the honest answer for a volume
 * nobody is looking at.
 */
import { describe, expect, it } from 'vitest'
import { mayReadLocation, STORAGE_LOCATION_MODES } from '@camstack/types'
import type { StorageLocationMode } from '@camstack/types'

const config = (): Record<string, unknown> => ({ basePath: '/recordings' })

describe('capacity follows readability, not the write set', () => {
  it('reports for every mode that still serves reads', () => {
    const readable: StorageLocationMode[] = ['active', 'readonly', 'drain']
    for (const mode of readable) {
      expect(mayReadLocation({ mode, config: config() })).toBe(true)
    }
  })

  it('reports nothing only for the mode the system does not touch', () => {
    const silent = STORAGE_LOCATION_MODES.filter(
      (mode) => !mayReadLocation({ mode, config: config() }),
    )
    expect(silent).toEqual(['disabled'])
  })

  it('a draining location is readable — the case the operator hit', () => {
    expect(mayReadLocation({ mode: 'drain', config: config() })).toBe(true)
  })
})
