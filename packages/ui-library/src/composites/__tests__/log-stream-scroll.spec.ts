import { describe, it, expect } from 'vitest'
import { isPinnedToBottom, PIN_THRESHOLD_PX } from '../log-stream-scroll'

describe('isPinnedToBottom', () => {
  it('is true at the exact bottom (distance 0)', () => {
    expect(isPinnedToBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
  })

  it('is true within the default threshold', () => {
    // distance = 1000 - 870 - 100 = 30 <= 40
    expect(isPinnedToBottom({ scrollTop: 870, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
  })

  it('is true exactly at the threshold boundary', () => {
    // distance = 1000 - 860 - 100 = 40 <= 40
    expect(isPinnedToBottom({ scrollTop: 860, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
  })

  it('is false just past the threshold (real scroll-up)', () => {
    // distance = 1000 - 859 - 100 = 41 > 40
    expect(isPinnedToBottom({ scrollTop: 859, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })

  it('is false when scrolled far up to read history', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })

  it('is true when content fits the viewport (no scroll possible)', () => {
    // distance = 100 - 0 - 100 = 0
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(true)
  })

  it('does NOT misread a burst-grown scrollHeight as pinned when scrollTop has not moved', () => {
    // This is the bug case: rows appended (scrollHeight jumped 1000 -> 1400)
    // but scrollTop is unchanged. distance = 1400 - 870 - 100 = 430 -> not pinned.
    // The pure helper correctly reports "not pinned" for the POST-growth geometry;
    // the component's job is to NOT call this with post-growth geometry on append
    // (it captures pinned-state from the PRE-growth layout instead).
    expect(isPinnedToBottom({ scrollTop: 870, scrollHeight: 1400, clientHeight: 100 })).toBe(false)
  })

  it('honours a custom threshold', () => {
    // distance = 1000 - 950 - 100 = -50 (overscroll) <= 0
    expect(isPinnedToBottom({ scrollTop: 950, scrollHeight: 1000, clientHeight: 100 }, 0)).toBe(
      true,
    )
    // distance = 5, threshold 0 -> false
    expect(isPinnedToBottom({ scrollTop: 895, scrollHeight: 1000, clientHeight: 100 }, 0)).toBe(
      false,
    )
  })

  it('exports a sane default threshold', () => {
    expect(PIN_THRESHOLD_PX).toBe(40)
  })
})
