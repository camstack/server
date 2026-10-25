import type { NcAlarmSettingsPatch } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modeDelaysFromPersisted } from '../alarm-mode-delays.js'
import { NcAlarmPanelDevice } from '../alarm-panel-device.js'
import { makePanelContext, type NcTestLogLine, TEST_PANEL_ID } from './panel-test-context.js'

const T0 = Date.UTC(2026, 9, 1, 20, 0, 0)

function build(persisted: Record<string, unknown>) {
  const config: Record<string, unknown> = {
    exitDelaySec: 30,
    entryDelaySec: 20,
    triggeredDurationSec: 0,
    ...persisted,
  }
  const logs: NcTestLogLine[] = []
  const { ctx, cap } = makePanelContext(config, logs)
  const panel = new NcAlarmPanelDevice(ctx)
  // Whatever the boot persisted is not what the specs below count.
  vi.mocked(ctx.persistConfig).mockClear()
  return { panel, cap: cap(), config, logs, ctx }
}

const at = (ms: number): void => {
  vi.setSystemTime(T0 + ms)
}

describe('per-mode delays are read at the transition that uses them (D697)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a blob without modeDelays arms and fires exactly as before', async () => {
    const { panel, cap } = build({})
    await panel.armWith('away')
    at(29_999)
    expect(panel.currentState()).toBe('arming')
    at(30_000)
    expect(panel.currentState()).toBe('armed_away')
    await cap.trigger({ deviceId: TEST_PANEL_ID })
    at(30_000 + 19_999)
    expect(panel.currentState()).toBe('pending')
    at(30_000 + 20_000)
    expect(panel.currentState()).toBe('triggered')
  })

  it('the armed mode exit override applies; another mode inherits', async () => {
    const { panel } = build({
      modeDelays: [{ mode: 'home', exitDelaySec: 0 }],
    })
    await panel.armWith('home')
    expect(panel.currentState()).toBe('armed_home')
    await panel.disarm()
    await panel.armWith('away')
    expect(panel.currentState()).toBe('arming')
  })

  it('an arm into home while armed_away uses HOME exit', async () => {
    const { panel } = build({
      modeDelays: [{ mode: 'home', exitDelaySec: 0 }],
    })
    await panel.armWith('away')
    at(30_000)
    expect(panel.currentState()).toBe('armed_away')
    await panel.armWith('home')
    expect(panel.currentState()).toBe('armed_home')
  })

  it('entry and siren come from the ARMED mode at trigger', async () => {
    const { panel, cap } = build({
      modeDelays: [
        {
          mode: 'night',
          exitDelaySec: 0,
          entryDelaySec: 5,
          triggeredDurationSec: 60,
        },
      ],
    })
    await panel.armWith('night')
    await cap.trigger({ deviceId: TEST_PANEL_ID })
    at(4_999)
    expect(panel.currentState()).toBe('pending')
    at(5_000)
    expect(panel.currentState()).toBe('triggered')
    at(5_000 + 60_000)
    expect(panel.currentState()).toBe('armed_night')
  })

  it('a change during the exit delay does not move the arm instant', async () => {
    const { panel } = build({})
    await panel.armWith('away')
    await panel.applySettings({
      modeDelays: [{ mode: 'away', exitDelaySec: 5 }],
    })
    at(5_000)
    expect(panel.currentState()).toBe('arming')
    at(30_000)
    expect(panel.currentState()).toBe('armed_away')
  })

  it('a change while armed applies at the NEXT trigger; one during the countdown does not', async () => {
    const { panel, cap } = build({
      modeDelays: [{ mode: 'away', exitDelaySec: 0 }],
    })
    await panel.armWith('away')
    await panel.applySettings({
      modeDelays: [{ mode: 'away', entryDelaySec: 3 }],
    })
    await cap.trigger({ deviceId: TEST_PANEL_ID })
    await panel.applySettings({
      modeDelays: [{ mode: 'away', entryDelaySec: 50 }],
    })
    at(3_000)
    expect(panel.currentState()).toBe('triggered')
  })

  it('a siren duration changed DURING the siren does not move its end', async () => {
    const { panel, cap } = build({
      modeDelays: [
        {
          mode: 'away',
          exitDelaySec: 0,
          entryDelaySec: 0,
          triggeredDurationSec: 60,
        },
      ],
    })
    await panel.armWith('away')
    await cap.trigger({ deviceId: TEST_PANEL_ID })
    at(10_000)
    expect(panel.currentState()).toBe('triggered')
    await panel.applySettings({
      modeDelays: [{ mode: 'away', triggeredDurationSec: 600 }],
    })
    at(60_000)
    expect(panel.currentState()).toBe('armed_away')
  })

  it('an arm during a siren ends it and applies the NEW mode exit', async () => {
    const { panel, cap } = build({
      modeDelays: [
        { mode: 'away', exitDelaySec: 0, entryDelaySec: 0 },
        { mode: 'night', exitDelaySec: 7 },
      ],
    })
    await panel.armWith('away')
    await cap.trigger({ deviceId: TEST_PANEL_ID })
    at(1_000)
    expect(panel.currentState()).toBe('triggered')
    await panel.armWith('night')
    expect(panel.currentState()).toBe('arming')
    at(1_000 + 7_000)
    expect(panel.currentState()).toBe('armed_night')
  })

  it('logs which values an arm used, tagged with the panel', async () => {
    const { panel, logs } = build({
      modeDelays: [{ mode: 'home', exitDelaySec: 0 }],
    })
    await panel.armWith('home')
    const line = logs.find((l) => l.message === 'alarm delays applied')
    expect(line?.deviceId).toBe(TEST_PANEL_ID)
    expect(line?.meta).toMatchObject({
      mode: 'home',
      phase: 'arm',
      exitDelaySec: 0,
      source: 'mode',
    })
  })
})

describe('applySettings — per-mode edits and one-membership edits', () => {
  it('two concurrent membership edits both land', async () => {
    const { panel } = build({})
    const first: NcAlarmSettingsPatch = {
      exitDelaySec: 31,
      nonBlockingEdit: { mode: 'away', deviceId: 1, nonBlocking: true },
    }
    const second: NcAlarmSettingsPatch = {
      nonBlockingEdit: { mode: 'away', deviceId: 2, nonBlocking: true },
    }
    await Promise.all([panel.applySettings(first), panel.applySettings(second)])
    const away = panel.settings().nonBlocking.find((l) => l.mode === 'away')
    expect([...(away?.deviceIds ?? [])].sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('a prune-style whole list + announceTargets does not erase a concurrent edit', async () => {
    const { panel } = build({
      nonBlocking: [{ mode: 'away', deviceIds: [3, 4] }],
    })
    // The prune computes its list synchronously from the panel, then calls (device-prune-runner).
    const snapshot = panel.settings().nonBlocking
    const pruned = snapshot.map((l) => ({
      mode: l.mode,
      deviceIds: l.deviceIds.filter((id) => id !== 4),
    }))
    const prune = panel.applySettings({
      announceTargets: ['t1'],
      nonBlocking: pruned,
    })
    const edit = panel.applySettings({
      nonBlockingEdit: { mode: 'away', deviceId: 9, nonBlocking: true },
    })
    await Promise.all([prune, edit])
    const away = panel.settings().nonBlocking.find((l) => l.mode === 'away')
    expect([...(away?.deviceIds ?? [])].sort((a, b) => a - b)).toEqual([3, 9])
    expect(panel.settings().announceTargets).toEqual(['t1'])
  })

  it('refuses a mode the panel does not offer, writing nothing, and says so', async () => {
    const { panel, logs, ctx } = build({})
    await expect(
      panel.applySettings({
        exitDelaySec: 99,
        modeDelays: [{ mode: 'vacation', exitDelaySec: 1 }],
      }),
    ).rejects.toThrow("alarm mode 'vacation' is not offered by this panel")
    expect(panel.settings().exitDelaySec).toBe(30)
    expect(panel.settings().modeDelays).toEqual([])
    expect(panel.settings().nonBlocking).toEqual([])
    expect(ctx.persistConfig).not.toHaveBeenCalled()
    expect(logs.some((l) => l.message === 'alarm settings refused')).toBe(true)
  })

  it('a refused patch writes no list either: nonBlocking and modeDelays stay as they were', async () => {
    const { panel, ctx } = build({
      modeDelays: [{ mode: 'away', exitDelaySec: 5 }],
      nonBlocking: [{ mode: 'away', deviceIds: [3] }],
    })
    await expect(
      panel.applySettings({
        nonBlocking: [{ mode: 'away', deviceIds: [8, 9] }],
        modeDelays: [{ mode: 'night', exitDelaySec: 1 }],
        nonBlockingEdit: { mode: 'vacation', deviceId: 77, nonBlocking: true },
      }),
    ).rejects.toThrow("alarm mode 'vacation' is not offered by this panel")
    expect(panel.settings().nonBlocking).toEqual([{ mode: 'away', deviceIds: [3] }])
    expect(panel.settings().modeDelays).toEqual([{ mode: 'away', exitDelaySec: 5 }])
    expect(ctx.persistConfig).not.toHaveBeenCalled()
  })

  it('a refused mode delay edit writes no whole-list nonBlocking', async () => {
    const { panel, ctx } = build({})
    await expect(
      panel.applySettings({
        nonBlocking: [{ mode: 'away', deviceIds: [8] }],
        modeDelays: [{ mode: 'vacation', exitDelaySec: 1 }],
      }),
    ).rejects.toThrow("alarm mode 'vacation' is not offered by this panel")
    expect(panel.settings().nonBlocking).toEqual([])
    expect(panel.settings().modeDelays).toEqual([])
    expect(ctx.persistConfig).not.toHaveBeenCalled()
  })

  it('refuses an add to a full list, by reason, writing nothing', async () => {
    const full = Array.from({ length: 200 }, (_, i) => i + 1)
    const { panel, ctx } = build({
      nonBlocking: [{ mode: 'away', deviceIds: full }],
    })
    await expect(
      panel.applySettings({
        exitDelaySec: 99,
        nonBlockingEdit: { mode: 'away', deviceId: 999, nonBlocking: true },
      }),
    ).rejects.toThrow('the away non-blocking list already holds 200 devices')
    expect(panel.settings().exitDelaySec).toBe(30)
    expect(panel.settings().modeDelays).toEqual([])
    expect(panel.settings().nonBlocking).toEqual([{ mode: 'away', deviceIds: full }])
    expect(ctx.persistConfig).not.toHaveBeenCalled()
  })

  it('a whole-list nonBlocking with a refused edit writes neither', async () => {
    const full = Array.from({ length: 200 }, (_, i) => i + 1)
    const { panel, ctx } = build({})
    await expect(
      panel.applySettings({
        nonBlocking: [{ mode: 'away', deviceIds: full }],
        nonBlockingEdit: { mode: 'away', deviceId: 999, nonBlocking: true },
      }),
    ).rejects.toThrow('the away non-blocking list already holds 200 devices')
    expect(panel.settings().nonBlocking).toEqual([])
    expect(ctx.persistConfig).not.toHaveBeenCalled()
  })

  it('a refused membership edit on an unoffered mode is tagged with the SENSOR and names the panel', async () => {
    const { panel, logs } = build({})
    await expect(
      panel.applySettings({
        nonBlockingEdit: { mode: 'vacation', deviceId: 77, nonBlocking: true },
      }),
    ).rejects.toThrow("alarm mode 'vacation' is not offered by this panel")
    const line = logs.find((l) => l.message === 'alarm settings refused')
    expect(line?.deviceId).toBe(77)
    expect(line?.meta).toMatchObject({
      reason: 'mode-not-offered',
      mode: 'vacation',
      panelId: TEST_PANEL_ID,
    })
  })

  it('two concurrent applySettings with different mode overrides both land', async () => {
    const { panel } = build({})
    await Promise.all([
      panel.applySettings({
        exitDelaySec: 31,
        modeDelays: [{ mode: 'away', entryDelaySec: 5 }],
      }),
      panel.applySettings({ modeDelays: [{ mode: 'night', exitDelaySec: 0 }] }),
    ])
    expect(panel.settings().modeDelays).toEqual(
      expect.arrayContaining([
        { mode: 'away', entryDelaySec: 5 },
        { mode: 'night', exitDelaySec: 0 },
      ]),
    )
    expect(panel.settings().modeDelays).toHaveLength(2)
    expect(panel.settings().exitDelaySec).toBe(31)
  })

  it('an edit keeps a persisted entry of a mode this release does not know', async () => {
    const { panel, config } = build({
      modeDelays: [{ mode: 'garden', exitDelaySec: 5 }],
    })
    await panel.applySettings({ modeDelays: [{ mode: 'away', exitDelaySec: 1 }] })
    expect(panel.settings().modeDelays).toEqual([{ mode: 'away', exitDelaySec: 1 }])
    expect(config['modeDelays']).toEqual(
      expect.arrayContaining([
        { mode: 'away', exitDelaySec: 1 },
        { mode: 'garden', exitDelaySec: 5 },
      ]),
    )
    expect(config['modeDelays']).toHaveLength(2)
  })

  it('an edit that discards a duplicate or out-of-bounds entry says so, once per entry', async () => {
    const { panel, logs } = build({
      modeDelays: [
        { mode: 'away', exitDelaySec: 9999, entryDelaySec: 4 },
        { mode: 'away', exitDelaySec: 2 },
      ],
    })
    await panel.applySettings({ modeDelays: [{ mode: 'night', exitDelaySec: 1 }] })
    const lines = logs.filter((l) => l.message === 'alarm per-mode delay discarded on write')
    expect(lines.map((l) => l.meta?.['why'])).toEqual(['out-of-bounds', 'duplicate-mode'])
    expect(lines.every((l) => l.deviceId === TEST_PANEL_ID)).toBe(true)
  })

  it('logs a membership edit on the SENSOR', async () => {
    const { panel, logs } = build({})
    await panel.applySettings({
      nonBlockingEdit: { mode: 'away', deviceId: 77, nonBlocking: true },
    })
    expect(logs.some((l) => l.deviceId === 77 && l.meta?.['mode'] === 'away')).toBe(true)
  })
})

describe('boot and restart under per-mode delays', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs one line per persisted entry the guard drops at boot, tagged with the panel', async () => {
    const { panel, logs } = build({ modeDelays: [{ mode: 'garden', exitDelaySec: 1 }] })
    const lines = logs.filter((l) => l.message === 'alarm per-mode delay dropped at boot')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.deviceId).toBe(TEST_PANEL_ID)
    expect(lines[0]?.meta).toMatchObject({ mode: 'garden', why: 'unknown-mode' })
    await panel.armWith('away')
    at(29_999)
    expect(panel.currentState()).toBe('arming')
    at(30_000)
    expect(panel.currentState()).toBe('armed_away')
  })

  it('a restart keeps the persisted instants even when the siren override differs from their span', () => {
    const { panel } = build({
      modeDelays: [{ mode: 'away', triggeredDurationSec: 60 }],
      machine: {
        target: 'armed_away',
        triggerAt: T0 + 3_000,
        clearAt: T0 + 10_000,
        fired: false,
        changedAt: T0 - 1_000,
      },
    })
    at(2_999)
    expect(panel.currentState()).toBe('pending')
    at(3_000)
    expect(panel.currentState()).toBe('triggered')
    at(9_999)
    expect(panel.currentState()).toBe('triggered')
    at(10_000)
    expect(panel.currentState()).toBe('armed_away')
  })
})

describe('modeDelaysFromPersisted', () => {
  it('drops an unknown mode, a duplicate and an out-of-bounds field, keeping the rest', () => {
    const out = modeDelaysFromPersisted([
      { mode: 'garden', exitDelaySec: 1 },
      { mode: 'away', exitDelaySec: 9999, entryDelaySec: 4 },
      { mode: 'away', exitDelaySec: 2 },
    ])
    expect(out.entries).toEqual([{ mode: 'away', entryDelaySec: 4 }])
    expect(out.dropped.map((d) => d.why)).toEqual([
      'unknown-mode',
      'out-of-bounds',
      'duplicate-mode',
    ])
  })

  it('keeps a valid activation schedule and drops a corrupt one', () => {
    const schedule = {
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1320, endMinute: 420 }],
    }
    const ok = modeDelaysFromPersisted([{ mode: 'night', schedule }])
    expect(ok.entries).toEqual([{ mode: 'night', schedule }])
    const bad = modeDelaysFromPersisted([{ mode: 'night', schedule: { windows: [] } }])
    expect(bad.entries).toEqual([])
    expect(bad.dropped).toEqual([{ mode: 'night', why: 'out-of-bounds', field: 'schedule' }])
  })
})

describe('activation schedule gates arm', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses arm when now is outside the mode schedule', async () => {
    const d = new Date(T0)
    const minute = d.getHours() * 60 + d.getMinutes()
    const other = (minute + 30) % 1440
    const { panel } = build({
      modeDelays: [
        {
          mode: 'night',
          schedule: {
            windows: [{ days: [d.getDay()], startMinute: other, endMinute: other + 1 }],
          },
        },
      ],
    })
    expect(await panel.armWith('night')).toEqual({ outcome: 'outside-schedule' })
    expect(panel.currentState()).toBe('disarmed')
  })

  it('arms when the schedule is absent', async () => {
    const { panel } = build({})
    const outcome = await panel.armWith('away')
    expect(outcome.outcome === 'armed' || outcome.outcome === 'arming').toBe(true)
  })
})
