import { describe, expect, it } from 'vitest'
import type { NcAlarmSettings } from '../../capabilities/notification-rules.cap.js'
import {
  alarmPatchLanded,
  applyModeDelaysEdits,
  applyNonBlockingEdit,
  resolveModeDelays,
} from '../alarm-settings.js'

const BASE: NcAlarmSettings = {
  exitDelaySec: 30,
  entryDelaySec: 20,
  triggeredDurationSec: 0,
  announceTargets: [],
  nonBlocking: [],
  blocking: [],
  secureOnArmOff: [],
  modeDelays: [],
}

describe('resolveModeDelays', () => {
  it('a mode with no entry inherits every global value', () => {
    expect(resolveModeDelays(BASE, 'away')).toEqual({
      exitDelaySec: 30,
      entryDelaySec: 20,
      triggeredDurationSec: 0,
      postTriggeredAction: 'doNothing',
      source: {
        exitDelaySec: 'default',
        entryDelaySec: 'default',
        triggeredDurationSec: 'default',
        postTriggeredAction: 'default',
      },
    })
  })

  it('derives rearmAfter from a positive triggeredDurationSec when action is absent', () => {
    const s = { ...BASE, triggeredDurationSec: 120 }
    expect(resolveModeDelays(s, 'away').postTriggeredAction).toBe('rearmAfter')
  })
  it('an older hub answer without modeDelays resolves to the global values', () => {
    const { modeDelays: _dropped, ...raw } = BASE
    expect(resolveModeDelays(raw, 'away').exitDelaySec).toBe(30)
  })
  it('a partial override replaces only its field', () => {
    const s = { ...BASE, modeDelays: [{ mode: 'home' as const, exitDelaySec: 0 }] }
    const home = resolveModeDelays(s, 'home')
    expect(home.exitDelaySec).toBe(0)
    expect(home.source.exitDelaySec).toBe('mode')
    expect(home.entryDelaySec).toBe(20)
    expect(home.source.entryDelaySec).toBe('default')
    expect(resolveModeDelays(s, 'away').exitDelaySec).toBe(30)
  })
})

describe('applyModeDelaysEdits', () => {
  it('sets, clears and keeps per field, and drops an entry left empty', () => {
    const current = [{ mode: 'away' as const, exitDelaySec: 60, entryDelaySec: 10 }]
    expect(applyModeDelaysEdits(current, [{ mode: 'away', exitDelaySec: null }])).toEqual([
      { mode: 'away', entryDelaySec: 10 },
    ])
    expect(
      applyModeDelaysEdits(current, [{ mode: 'away', exitDelaySec: null, entryDelaySec: null }]),
    ).toEqual([])
    expect(applyModeDelaysEdits(current, [{ mode: 'night', triggeredDurationSec: 90 }])).toEqual([
      { mode: 'away', exitDelaySec: 60, entryDelaySec: 10 },
      { mode: 'night', triggeredDurationSec: 90 },
    ])
  })
  it('never mutates its input', () => {
    const current = [{ mode: 'away' as const, exitDelaySec: 60 }]
    applyModeDelaysEdits(current, [{ mode: 'away', exitDelaySec: 5 }])
    expect(current).toEqual([{ mode: 'away', exitDelaySec: 60 }])
  })

  it('sets and clears a per-mode activation schedule', () => {
    const schedule = {
      windows: [{ days: [1, 2, 3, 4, 5], startMinute: 1320, endMinute: 420 }],
    }
    const set = applyModeDelaysEdits([], [{ mode: 'night', schedule }])
    expect(set).toEqual([{ mode: 'night', schedule }])
    expect(applyModeDelaysEdits(set, [{ mode: 'night', schedule: null }])).toEqual([])
  })
})

describe('applyNonBlockingEdit', () => {
  it('adds, is idempotent, removes, and drops an emptied list', () => {
    const added = applyNonBlockingEdit([], { mode: 'away', deviceId: 7, nonBlocking: true })
    expect(added).toEqual({
      kind: 'applied',
      lists: [{ mode: 'away', deviceIds: [7] }],
      changed: true,
    })
    if (added.kind !== 'applied') throw new Error('expected applied')
    expect(
      applyNonBlockingEdit(added.lists, { mode: 'away', deviceId: 7, nonBlocking: true }),
    ).toEqual({
      kind: 'applied',
      lists: [{ mode: 'away', deviceIds: [7] }],
      changed: false,
    })
    expect(
      applyNonBlockingEdit(added.lists, { mode: 'away', deviceId: 7, nonBlocking: false }),
    ).toEqual({
      kind: 'applied',
      lists: [],
      changed: true,
    })
  })
  it('refuses an add to a full list, by reason', () => {
    const full = [{ mode: 'away' as const, deviceIds: Array.from({ length: 200 }, (_, i) => i) }]
    expect(applyNonBlockingEdit(full, { mode: 'away', deviceId: 999, nonBlocking: true })).toEqual({
      kind: 'refused',
      reason: 'list-full',
      mode: 'away',
      max: 200,
    })
  })
})

describe('alarmPatchLanded', () => {
  it('sees a stripped nonBlockingEdit', () => {
    const patch = { nonBlockingEdit: { mode: 'away' as const, deviceId: 7, nonBlocking: true } }
    expect(alarmPatchLanded(patch, BASE)).toBe(false)
    expect(
      alarmPatchLanded(patch, { ...BASE, nonBlocking: [{ mode: 'away', deviceIds: [7] }] }),
    ).toBe(true)
  })
  it('sees a stripped modeDelays edit, and a cleared field as absent', () => {
    expect(alarmPatchLanded({ modeDelays: [{ mode: 'away', exitDelaySec: 45 }] }, BASE)).toBe(false)
    expect(
      alarmPatchLanded(
        { modeDelays: [{ mode: 'away', exitDelaySec: 45 }] },
        { ...BASE, modeDelays: [{ mode: 'away', exitDelaySec: 45 }] },
      ),
    ).toBe(true)
    expect(alarmPatchLanded({ modeDelays: [{ mode: 'away', exitDelaySec: null }] }, BASE)).toBe(
      true,
    )
  })
  it('does not throw on an older hub answer without modeDelays (raw, unparsed)', () => {
    const { modeDelays: _dropped, ...raw } = BASE
    expect(alarmPatchLanded({ modeDelays: [{ mode: 'away', exitDelaySec: 45 }] }, raw)).toBe(false)
    expect(alarmPatchLanded({ modeDelays: [{ mode: 'away', exitDelaySec: null }] }, raw)).toBe(true)
    expect(alarmPatchLanded({ exitDelaySec: 30 }, raw)).toBe(true)
  })
  it('does not throw on a hub older than D636 (raw answer without nonBlocking)', () => {
    const { nonBlocking: _dropped, ...raw } = BASE
    // An edit that ADDS cannot have landed; one that removes an absent id trivially has.
    expect(
      alarmPatchLanded({ nonBlockingEdit: { mode: 'home', deviceId: 7, nonBlocking: true } }, raw),
    ).toBe(false)
    expect(
      alarmPatchLanded({ nonBlockingEdit: { mode: 'home', deviceId: 7, nonBlocking: false } }, raw),
    ).toBe(true)
    expect(alarmPatchLanded({ nonBlocking: [{ mode: 'home', deviceIds: [7] }] }, raw)).toBe(false)
    expect(alarmPatchLanded({ nonBlocking: [] }, raw)).toBe(true)
  })
  it('a null clear the host did not apply is NOT landed', () => {
    const held = { ...BASE, modeDelays: [{ mode: 'away' as const, exitDelaySec: 45 }] }
    expect(alarmPatchLanded({ modeDelays: [{ mode: 'away', exitDelaySec: null }] }, held)).toBe(
      false,
    )
  })
  it('a numeric edit landing on a different value is not landed', () => {
    const held = { ...BASE, modeDelays: [{ mode: 'away' as const, exitDelaySec: 10 }] }
    expect(alarmPatchLanded({ modeDelays: [{ mode: 'away', exitDelaySec: 45 }] }, held)).toBe(false)
  })
  it('checks each global delay', () => {
    expect(alarmPatchLanded({ exitDelaySec: 31 }, BASE)).toBe(false)
    expect(alarmPatchLanded({ entryDelaySec: 21 }, BASE)).toBe(false)
    expect(alarmPatchLanded({ triggeredDurationSec: 5 }, BASE)).toBe(false)
    expect(
      alarmPatchLanded({ exitDelaySec: 30, entryDelaySec: 20, triggeredDurationSec: 0 }, BASE),
    ).toBe(true)
  })
  it('compares announceTargets as a set', () => {
    const returned = { ...BASE, announceTargets: ['2', '1'] }
    expect(alarmPatchLanded({ announceTargets: ['1', '2'] }, returned)).toBe(true)
    expect(alarmPatchLanded({ announceTargets: ['1', '3'] }, returned)).toBe(false)
    expect(alarmPatchLanded({ announceTargets: ['1'] }, BASE)).toBe(false)
  })
  it('compares a whole nonBlocking list per mode, empty lists ignored', () => {
    const returned = { ...BASE, nonBlocking: [{ mode: 'away' as const, deviceIds: [1, 2] }] }
    expect(alarmPatchLanded({ nonBlocking: [{ mode: 'away', deviceIds: [2, 1] }] }, returned)).toBe(
      true,
    )
    expect(alarmPatchLanded({ nonBlocking: [{ mode: 'away', deviceIds: [1] }] }, returned)).toBe(
      false,
    )
    expect(
      alarmPatchLanded(
        {
          nonBlocking: [
            { mode: 'away', deviceIds: [1, 2] },
            { mode: 'home', deviceIds: [] },
          ],
        },
        returned,
      ),
    ).toBe(true)
    expect(alarmPatchLanded({ nonBlocking: [] }, returned)).toBe(false)
  })
})
