import type { StorageLocationMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type MediaLocation, pickWritableMediaLocation } from '../media-locations.js'

const loc = (id: string, mode: StorageLocationMode): MediaLocation => ({
  id,
  mode,
  headroomBytes: 1_000,
})

describe('pickWritableMediaLocation', () => {
  it('does not write to a readonly location — it is the operator drain', () => {
    const picked = pickWritableMediaLocation(
      [loc('vecchia', 'readonly'), loc('nuova', 'active')],
      'vecchia',
    )
    expect(picked).toBe('nuova')
  })

  it('keeps the current choice while it is writable — no gratuitous bounce', () => {
    const picked = pickWritableMediaLocation([loc('a', 'active'), loc('b', 'active')], 'a')
    expect(picked).toBe('a')
  })

  it('answers null when NONE is writable instead of choosing at random', () => {
    // The caller must be able to log and refuse. Returning a
    // non-writable location anyway would make every write fail with a
    // filesystem error, much further from the cause.
    expect(pickWritableMediaLocation([loc('a', 'readonly')], 'a')).toBeNull()
  })

  it('skips drain and disabled — only `active` is a write target (D385)', () => {
    expect(pickWritableMediaLocation([loc('a', 'drain'), loc('b', 'active')], 'a')).toBe('b')
    expect(pickWritableMediaLocation([loc('a', 'disabled'), loc('b', 'active')], 'a')).toBe('b')
  })
})
