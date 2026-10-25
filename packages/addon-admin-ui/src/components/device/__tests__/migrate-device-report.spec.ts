/**
 * What a migration report is allowed to CLAIM.
 *
 * `deviceManager.migrateDevice` returns no success flag on purpose
 * (`packages/system/src/builtins/device-manager/migrate-device.ts`), and the
 * three rules below are the reason. Each one has a concrete failure behind it:
 *
 *  - A non-empty `sourceStillLive` announced as "done" sends an operator away
 *    from a camera that is still filming.
 *  - A `not-offered` switch counted as still live sends them to unplug a
 *    microphone the camera never had.
 *  - The UP phase re-uses the SOURCE number after the swap, so a naive
 *    `deviceId === sourceId` filter mixes the new hardware's answers into the
 *    old hardware's report.
 */
import { describe, expect, it } from 'vitest'
import type { MigrateDeviceResult, MigrateSwitchReport } from '@camstack/types'

import { buildMigrationReport } from '../migrate-device-report'

const OLD = 102
const NEW = 992

function report(
  overrides: Partial<MigrateDeviceResult> & Pick<MigrateDeviceResult, 'switches'>,
): MigrateDeviceResult {
  return {
    sourceId: OLD,
    targetId: NEW,
    sourceStillLive: [],
    swapped: true,
    ...overrides,
  }
}

function row(
  deviceId: number,
  switchId: MigrateSwitchReport['switchId'],
  outcome: MigrateSwitchReport['outcome'],
  detail?: string,
): MigrateSwitchReport {
  return detail === undefined
    ? { deviceId, switchId, outcome }
    : { deviceId, switchId, outcome, detail }
}

describe('buildMigrationReport', () => {
  it('empty sourceStillLive is the ONLY quiet verdict', () => {
    const built = buildMigrationReport(
      report({
        switches: [row(OLD, 'recording', 'off'), row(NEW, 'recording', 'off')],
        sourceStillLive: [],
      }),
    )
    expect(built.verdict).toBe('quiet')
    expect(built.stillLive).toEqual([])
  })

  it('a non-empty sourceStillLive is STILL-LIVE, named, and never quiet', () => {
    const built = buildMigrationReport(
      report({
        switches: [
          row(OLD, 'privacy-mask', 'unreachable', 'ECONNREFUSED 192.168.10.44:80'),
          row(OLD, 'device-audio', 'unreachable', 'ECONNREFUSED 192.168.10.44:80'),
          row(OLD, 'recording', 'off'),
        ],
        sourceStillLive: ['privacy-mask', 'device-audio'],
      }),
    )
    expect(built.verdict).toBe('still-live')
    expect(built.stillLive.map((line) => line.switchId)).toEqual(['privacy-mask', 'device-audio'])
    // Operator-facing names, never the raw ids.
    expect(built.stillLive.map((line) => line.label)).toEqual(['Privacy mask', 'Camera microphone'])
    // The refusal is quoted verbatim — it is the only clue about WHY.
    expect(built.stillLive[0]?.detail).toBe('ECONNREFUSED 192.168.10.44:80')
  })

  it('not-offered is NOT still live — it gets its own list and stays out of the verdict', () => {
    const built = buildMigrationReport(
      report({
        switches: [
          row(OLD, 'device-audio', 'not-offered', 'camera does not offer audio'),
          row(OLD, 'recording', 'off'),
        ],
        sourceStillLive: [],
      }),
    )
    expect(built.verdict).toBe('quiet')
    expect(built.stillLive).toEqual([])
    expect(built.neverOffered.map((line) => line.switchId)).toEqual(['device-audio'])
  })

  it('keeps unreachable and not-offered in SEPARATE lists on the same report', () => {
    const built = buildMigrationReport(
      report({
        switches: [
          row(OLD, 'privacy-mask', 'unreachable', 'timed out'),
          row(OLD, 'device-audio', 'not-offered', 'camera does not offer audio'),
        ],
        sourceStillLive: ['privacy-mask'],
      }),
    )
    expect(built.stillLive.map((line) => line.switchId)).toEqual(['privacy-mask'])
    expect(built.neverOffered.map((line) => line.switchId)).toEqual(['device-audio'])
  })

  it('reads the DOWN phase only — the UP phase re-uses the source number for the NEW hardware', () => {
    const built = buildMigrationReport(
      report({
        switches: [
          // DOWN on the old camera.
          row(OLD, 'recording', 'off'),
          // DOWN on the replacement.
          row(NEW, 'recording', 'off'),
          // UP — after the swap `sourceId` names the NEW hardware, and this
          // camera genuinely lacks the switch. It must not be attributed to the
          // camera that was replaced.
          row(OLD, 'recording', 'not-offered', 'not available on this model'),
        ],
        sourceStillLive: [],
      }),
    )
    expect(built.neverOffered).toEqual([])
  })

  it('names the number the replacement inherited and the one the old camera was handed', () => {
    const built = buildMigrationReport(report({ switches: [] }))
    expect(built.inheritedId).toBe(OLD)
    expect(built.retiredId).toBe(NEW)
    expect(built.swapped).toBe(true)
  })
})
