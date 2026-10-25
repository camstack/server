import type { NcAlarmModeCoverage, NcAlarmSettings } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type AlarmSensorRow,
  alarmCoverageCell,
  alarmCoverageNeverBlocks,
  alarmSensorCell,
  alarmSensorReadChunks,
  alarmSensorRows,
  alarmSensorTableState,
  alarmSwitchOutcome,
  beginAlarmSwitch,
} from '../alarm-sensor-table-model'

const COVERAGE: NcAlarmModeCoverage = {
  mode: 'away',
  ruleCount: 1,
  allDevices: false,
  allDevicesExcept: [],
  deviceIds: [1, 2],
  skippedDevices: [{ deviceId: 2, reason: 'offline' }],
}

describe('alarmSensorCell — D315: only an answer says closed', () => {
  it('pending checks; the three by-name refusals are an old hub; anything else failed', () => {
    expect(alarmSensorCell({ status: 'pending' }, 1, false)).toEqual({ kind: 'checking' })
    for (const error of [
      'child-addon-call: addon "pipeline-analytics" has no custom action "nc.getAlarmSensors"',
      'No "query"-procedure on path "notificationRules.getAlarmSensors"',
      "child-cap-dispatch: method 'getAlarmSensors' not found on provider 'notification-rules'",
    ]) {
      expect(alarmSensorCell({ status: 'failed', error }, 1, false)).toEqual({
        kind: 'hub-too-old',
      })
    }
    expect(alarmSensorCell({ status: 'failed', error: 'timeout' }, 1, false)).toEqual({
      kind: 'read-failed',
      error: 'timeout',
    })
  })
  it('an id the answer lacks is unknown, not closed', () => {
    expect(alarmSensorCell({ status: 'answered', sensors: [] }, 1, false)).toEqual({
      kind: 'unknown',
      why: 'not-answered',
    })
  })
  it('an offline closed contact says last known', () => {
    const sensors = [
      {
        deviceId: 1,
        reading: 'closed' as const,
        state: 'closed',
        unknownWhy: null,
        online: false,
        controllable: false,
      },
    ]
    expect(alarmSensorCell({ status: 'answered', sensors }, 1, false)).toEqual({
      kind: 'closed',
      word: 'closed',
      offline: true,
    })
  })
  it('an unknown reading keeps the reason the hub gave, and defaults to read-failed', () => {
    const unknown = (unknownWhy: 'unknown-word' | null) => [
      {
        deviceId: 1,
        reading: 'unknown' as const,
        state: null,
        unknownWhy,
        online: true,
        controllable: false,
      },
    ]
    expect(
      alarmSensorCell({ status: 'answered', sensors: unknown('unknown-word') }, 1, false),
    ).toEqual({ kind: 'unknown', why: 'unknown-word' })
    expect(alarmSensorCell({ status: 'answered', sensors: unknown(null) }, 1, false)).toEqual({
      kind: 'unknown',
      why: 'read-failed',
    })
  })
  it('a removed device is removed whatever the read says', () => {
    expect(alarmSensorCell({ status: 'pending' }, 1, true)).toEqual({ kind: 'removed' })
  })
})

describe('alarmCoverageCell — equal to the arm check', () => {
  it('a named id is arm-checked; a skipped one still blocks', () => {
    expect(alarmCoverageCell(COVERAGE, 1)).toEqual({ kind: 'arm-checked' })
    expect(alarmCoverageCell(COVERAGE, 2)).toEqual({
      kind: 'arm-checked-skipped',
      reason: 'offline',
    })
    expect(alarmCoverageCell(COVERAGE, 3)).toEqual({ kind: 'not-covered' })
  })
  it('a skipped id outside deviceIds is not covered — the skip list never adds an id', () => {
    const stray = { ...COVERAGE, skippedDevices: [{ deviceId: 7, reason: 'offline' as const }] }
    expect(alarmCoverageCell(stray, 7)).toEqual({ kind: 'not-covered' })
  })
  it('an all-devices rule is NOT read by the arm check: unscoped, never blocks', () => {
    const all = { ...COVERAGE, allDevices: true, allDevicesExcept: [3] }
    expect(alarmCoverageCell(all, 9)).toEqual({ kind: 'unscoped' })
    expect(alarmCoverageNeverBlocks(alarmCoverageCell(all, 9))).toBe(true)
    expect(alarmCoverageCell(all, 3)).toEqual({ kind: 'not-covered' })
    expect(alarmCoverageCell(all, 1)).toEqual({ kind: 'arm-checked' })
  })
})

describe('alarmSensorRows', () => {
  it('one row per candidate, the switch ON unless listed, removed kept as a row', () => {
    const rows = alarmSensorRows({
      candidates: [
        { id: 2, name: 'Porch' },
        { id: 1, name: 'Bathroom' },
        { id: 5, name: 'Device #5 — removed' },
      ],
      removedIds: new Set([5]),
      coverage: COVERAGE,
      nonBlocking: [2, 5],
      blocking: [],
      secureOnArmOff: [],
      sensors: { status: 'pending' },
    })
    expect(rows.map((r) => [r.device.id, r.blocks, r.cell.kind])).toEqual([
      [1, true, 'checking'],
      [5, false, 'removed'],
      [2, false, 'checking'],
    ])
  })
})

describe('alarmSensorRows — Q2 (2026-10-02): a sensor no rule of the mode covers is not a row', () => {
  const base = {
    removedIds: new Set<number>(),
    sensors: { status: 'pending' as const },
    blocking: [] as const,
    secureOnArmOff: [] as const,
  }
  const ids = (rows: readonly AlarmSensorRow[]) => rows.map((r) => r.device.id)

  it('hides a candidate no rule names, and keeps the arm-checked ones (skipped included)', () => {
    const rows = alarmSensorRows({
      ...base,
      candidates: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
      ],
      coverage: COVERAGE,
      nonBlocking: [],
    })
    expect(ids(rows)).toEqual([1, 2])
    expect(rows.every((r) => !r.listedUncovered)).toBe(true)
  })

  it('hides a device covered ONLY by an all-devices rule — the arm check never reads it', () => {
    const all = { ...COVERAGE, allDevices: true, allDevicesExcept: [], deviceIds: [1] }
    const rows = alarmSensorRows({
      ...base,
      candidates: [
        { id: 1, name: 'A' },
        { id: 9, name: 'Z' },
      ],
      coverage: all,
      nonBlocking: [],
    })
    expect(ids(rows)).toEqual([1])
  })

  it('shows an uncovered sensor that IS listed, flagged, so the entry can be removed (D49)', () => {
    for (const coverage of [COVERAGE, { ...COVERAGE, allDevices: true }]) {
      const rows = alarmSensorRows({
        ...base,
        candidates: [
          { id: 1, name: 'A' },
          { id: 9, name: 'Z' },
        ],
        coverage,
        nonBlocking: [9],
      })
      expect(rows.map((r) => [r.device.id, r.listedUncovered, r.blocks])).toEqual([
        [1, false, true],
        [9, true, false],
      ])
    }
  })

  it('keeps a removed id as a row even when nothing covers it, and does not flag it', () => {
    const rows = alarmSensorRows({
      ...base,
      candidates: [{ id: 5, name: 'Device #5 — removed' }],
      removedIds: new Set([5]),
      coverage: COVERAGE,
      nonBlocking: [],
    })
    expect(rows.map((r) => [r.device.id, r.cell.kind, r.listedUncovered])).toEqual([
      [5, 'removed', false],
    ])
  })

  it('a controllable covered device defaults to blocks OFF and secure ON', () => {
    const rows = alarmSensorRows({
      ...base,
      candidates: [{ id: 1, name: 'Shutter', type: 'cover' }],
      coverage: COVERAGE,
      nonBlocking: [],
      sensors: {
        status: 'answered',
        sensors: [
          {
            deviceId: 1,
            reading: 'open',
            state: 'open',
            unknownWhy: null,
            online: true,
            controllable: true,
          },
        ],
      },
    })
    expect(rows.map((r) => [r.device.id, r.controllable, r.blocks, r.secureOnArm])).toEqual([
      [1, true, false, true],
    ])
  })
})

describe('alarmSensorTableState — D315: pending is not "none"', () => {
  it('rows when there are rows; pending while the candidates are incomplete; none only when complete', () => {
    expect(alarmSensorTableState({ rowCount: 2, candidatesComplete: false })).toBe('rows')
    expect(alarmSensorTableState({ rowCount: 0, candidatesComplete: false })).toBe('pending')
    expect(alarmSensorTableState({ rowCount: 0, candidatesComplete: true })).toBe('none')
  })
})

describe('alarmSensorReadChunks', () => {
  it('dedupes, sorts and splits by the bound', () => {
    expect(alarmSensorReadChunks([5, 1, 5, 3, 2], 2)).toEqual([
      [1, 2],
      [3, 5],
    ])
    expect(alarmSensorReadChunks([], 500)).toEqual([])
  })
  it('refuses a bound below 1 instead of looping forever', () => {
    expect(() => alarmSensorReadChunks([1, 2], 0)).toThrow(/bound/)
    expect(() => alarmSensorReadChunks([1, 2], -3)).toThrow(/bound/)
  })
})

describe('single-flight switch writes', () => {
  const row = (id: number, name: string, controllable = false): AlarmSensorRow => ({
    device: { id, name },
    removed: false,
    cell: { kind: 'checking' },
    coverage: { kind: 'arm-checked' },
    controllable,
    blocks: !controllable,
    secureOnArm: controllable,
    listedUncovered: false,
  })
  it('a second write while one is in flight is refused naming the first', () => {
    const first = beginAlarmSwitch(null, 'away', row(1, 'Bathroom'), 'blocks', false)
    expect(first).toEqual({
      kind: 'start',
      write: {
        mode: 'away',
        deviceId: 1,
        name: 'Bathroom',
        kind: 'blocks',
        nextValue: false,
        controllable: false,
      },
    })
    if (first.kind !== 'start') throw new Error('expected start')
    expect(beginAlarmSwitch(first.write, 'away', row(2, 'Porch'), 'blocks', false)).toEqual({
      kind: 'refused',
      inFlight: first.write,
    })
  })
  it('a stripped edit is not landed', () => {
    const settings: NcAlarmSettings = {
      exitDelaySec: 30,
      entryDelaySec: 20,
      triggeredDurationSec: 0,
      announceTargets: [],
      nonBlocking: [],
      blocking: [],
      secureOnArmOff: [],
      modeDelays: [],
    }
    const write = {
      mode: 'away' as const,
      deviceId: 1,
      name: 'Bathroom',
      kind: 'blocks' as const,
      nextValue: false,
      controllable: false,
    }
    expect(alarmSwitchOutcome(write, settings)).toEqual({ kind: 'not-landed' })
    expect(
      alarmSwitchOutcome(write, { ...settings, nonBlocking: [{ mode: 'away', deviceIds: [1] }] }),
    ).toEqual({ kind: 'landed' })
  })
})
