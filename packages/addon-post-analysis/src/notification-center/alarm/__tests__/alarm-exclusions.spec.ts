/**
 * WHAT A BYPASS ACTUALLY EXCLUDES, and for how long.
 *
 * The sharp end of arming with a window open. Get this wrong in either
 * direction and the feature is worse than nothing:
 *
 *  - too weak, and the excluded window sets the alarm off `entryDelaySec`
 *    after the operator armed it — the exact thing the bypass promised not to
 *    do;
 *  - too strong, and the window stays excluded for the rest of the night, so
 *    the one sensor the operator KNOWS was open is the one that never fires.
 *
 * The rule these tests pin: an excluded sensor is re-armed by its next OPEN
 * after a close. Not by the close itself — the close is a state change, the
 * rule fires on it, and lifting the exclusion on the close would turn shutting
 * the window into the thing that triggers the alarm.
 */

import { describe, expect, it } from 'vitest'
import { NcAlarmExclusions } from '../alarm-exclusions.js'

const PORCH = 3243
const RETRO = 3272

describe('NcAlarmExclusions', () => {
  it('is empty until an arm excludes something', () => {
    const ex = new NcAlarmExclusions()
    expect(ex.list()).toEqual([])
    expect(ex.blocks(PORCH)).toBe(false)
  })

  it('blocks every sensor the bypass excluded', () => {
    const ex = new NcAlarmExclusions()
    ex.exclude([PORCH, RETRO], 1_000)
    expect(ex.list()).toEqual([PORCH, RETRO])
    expect(ex.blocks(PORCH)).toBe(true)
    expect(ex.blocks(RETRO)).toBe(true)
    // Never anything else: an exclusion is per sensor, not per mode.
    expect(ex.blocks(9999)).toBe(false)
  })

  it('KEEPS blocking through the close — the close must not be the trigger', () => {
    const ex = new NcAlarmExclusions()
    ex.exclude([PORCH], 1_000)
    expect(ex.observe(PORCH, 'secure', 2_000)).toBe('closed')
    expect(ex.blocks(PORCH)).toBe(true)
  })

  it('re-arms the sensor on the OPEN that follows a close', () => {
    const ex = new NcAlarmExclusions()
    ex.exclude([PORCH], 1_000)
    ex.observe(PORCH, 'secure', 2_000)
    expect(ex.observe(PORCH, 'open', 3_000)).toBe('rearmed')
    expect(ex.blocks(PORCH)).toBe(false)
    expect(ex.list()).toEqual([])
  })

  it('does NOT re-arm on an open that never saw a close', () => {
    // A contact that bounces open→open (a re-published slice, a provider
    // reconnect) has not been shut. Lifting on that would arm the very sensor
    // the operator told us to ignore, without them touching it.
    const ex = new NcAlarmExclusions()
    ex.exclude([PORCH], 1_000)
    expect(ex.observe(PORCH, 'open', 2_000)).toBe('unchanged')
    expect(ex.blocks(PORCH)).toBe(true)
  })

  it('ignores a state it cannot read — an unknown reading changes nothing', () => {
    const ex = new NcAlarmExclusions()
    ex.exclude([PORCH], 1_000)
    expect(ex.observe(PORCH, undefined, 2_000)).toBe('unchanged')
    expect(ex.observe(PORCH, 'secure', 3_000)).toBe('closed')
    // A failed read between the close and the re-open must not swallow the
    // close — D49: a read that fails changes nothing.
    expect(ex.observe(PORCH, undefined, 4_000)).toBe('unchanged')
    expect(ex.observe(PORCH, 'open', 5_000)).toBe('rearmed')
  })

  it('ignores a sensor it never excluded', () => {
    const ex = new NcAlarmExclusions()
    expect(ex.observe(PORCH, 'open', 1_000)).toBe('unchanged')
    expect(ex.list()).toEqual([])
  })

  it('drops everything on clear — a disarm ends the exclusions with the arm', () => {
    const ex = new NcAlarmExclusions()
    ex.exclude([PORCH, RETRO], 1_000)
    ex.clear()
    expect(ex.list()).toEqual([])
    expect(ex.blocks(PORCH)).toBe(false)
  })

  it('replaces the whole set on a new arm', () => {
    const ex = new NcAlarmExclusions()
    ex.exclude([PORCH], 1_000)
    ex.exclude([RETRO], 2_000)
    expect(ex.list()).toEqual([RETRO])
  })

  describe('durability — a restart mid-armed keeps the exclusions', () => {
    it('round-trips through the persisted blob, phase included', () => {
      const ex = new NcAlarmExclusions()
      ex.exclude([PORCH, RETRO], 1_000)
      ex.observe(RETRO, 'secure', 2_000)

      const restored = new NcAlarmExclusions()
      restored.restore(ex.snapshot())

      expect(restored.list()).toEqual([PORCH, RETRO])
      // The PHASE survives, not only the membership: a window already shut
      // before the restart must still re-arm on its next open, and one still
      // open must still need a close first.
      expect(restored.observe(RETRO, 'open', 3_000)).toBe('rearmed')
      expect(restored.observe(PORCH, 'open', 3_000)).toBe('unchanged')
    })

    it('restores nothing from a blob it cannot read, rather than guessing', () => {
      const ex = new NcAlarmExclusions()
      ex.restore('not a snapshot')
      expect(ex.list()).toEqual([])
      ex.restore([{ deviceId: 'x' }])
      expect(ex.list()).toEqual([])
      ex.restore(undefined)
      expect(ex.list()).toEqual([])
    })

    it('reads a blob written by a build that only stored the ids', () => {
      // Forward-compatibility in the direction that matters: an id with no
      // phase is treated as still OPEN, which is the safe half — it needs a
      // close before it can re-arm, and it never fires in the meantime.
      const ex = new NcAlarmExclusions()
      ex.restore([PORCH])
      expect(ex.list()).toEqual([PORCH])
      expect(ex.observe(PORCH, 'open', 2_000)).toBe('unchanged')
    })
  })
})

describe('a DELETED excluded device', () => {
  it('is forgotten — it will never report the close that would lift it', () => {
    const ex = new NcAlarmExclusions()
    ex.exclude([102, 101], 1_000)
    expect(ex.forget(102)).toBe(true)
    expect(ex.list()).toEqual([101])
    expect(ex.forget(102)).toBe(false)
  })
})
