/**
 * A timelapse renders from the CHEAPEST band that has footage.
 *
 * ## What this replaces, and why
 *
 * The rule used to be "the profile with the MOST coverage", ties broken by
 * name. That picks `high` almost every time, because the high band is the one
 * that records continuously — and on 2026-09-03 it did exactly that on a test
 * render: `profile=high`, 97% coverage, a ten-hour window. On this hub `high`
 * is 4K on a USB spinning disk. Decoding it took the machine off SSH and off
 * its own web UI for half an hour; it had to be power-cycled.
 *
 * A timelapse is watched accelerated: resolution buys nothing at 12 fps over a
 * night, while the bands differ by one to two orders of magnitude in bytes read
 * and frames decoded. There is no trade to weigh, so coverage no longer decides
 * WHICH band — only whether a band qualifies at all.
 *
 * These assertions are about the CHOICE, never about how much footage came
 * back: a rule that returned the right coverage number from the wrong band is
 * exactly the failure being fixed.
 */
import { describe, expect, it } from 'vitest'
import { pickProfile, type TimelapseAvailabilityRange } from '../timelapse-renderer.js'

const START = 1_000_000
const END = START + 10 * 3_600_000

function range(profile: string, fromMs: number, toMs: number): TimelapseAvailabilityRange {
  return { profile, startMs: fromMs, endMs: toMs }
}

const WINDOW = { startMs: START, endMs: END }

describe('pickProfile — cost decides, not coverage', () => {
  it('takes low even when high covers more — the 2026-09-03 case', () => {
    const chosen = pickProfile(
      [range('high', START, END), range('low', START, START + 9 * 3_600_000)],
      WINDOW,
    )
    expect(chosen?.profile).toBe('low')
  })

  it('takes low even when its footage is a thin sliver', () => {
    const chosen = pickProfile(
      [range('high', START, END), range('low', START, START + 60_000)],
      WINDOW,
    )
    expect(chosen?.profile).toBe('low')
  })

  it('falls to mid when low has nothing at all', () => {
    const chosen = pickProfile([range('high', START, END), range('mid', START, END)], WINDOW)
    expect(chosen?.profile).toBe('mid')
  })

  it('uses high only when it is the only band there', () => {
    const chosen = pickProfile([range('high', START, END)], WINDOW)
    expect(chosen?.profile).toBe('high')
  })

  it('a band whose footage misses the window entirely does not qualify', () => {
    const chosen = pickProfile(
      [range('low', END + 3_600_000, END + 7_200_000), range('mid', START, END)],
      WINDOW,
    )
    expect(chosen?.profile).toBe('mid')
  })

  it('no footage in any band is still null', () => {
    expect(pickProfile([], WINDOW)).toBeNull()
  })

  it('an unknown band sorts after the known ones, deterministically', () => {
    const chosen = pickProfile([range('bespoke', START, END), range('mid', START, END)], WINDOW)
    expect(chosen?.profile).toBe('mid')
  })
})
