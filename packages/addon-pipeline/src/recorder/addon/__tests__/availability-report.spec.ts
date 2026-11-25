/**
 * planning#721 — the periodic availability line: per recording camera, what a
 * reader is served for the last 24 h next to what the hour ledger accounts
 * for. `info` when they agree, `warn` when they do not.
 */
import { describe, expect, it } from 'vitest'
import {
  type AvailabilityLedgerHour,
  type AvailabilityReportDeps,
  reportAvailability,
} from '../availability-report.js'

const HOUR_MS = 3_600_000
const NOW = Date.UTC(2026, 10, 25, 19, 6)
const CURRENT_HOUR = Date.UTC(2026, 10, 25, 19)

interface Line {
  readonly level: 'info' | 'warn'
  readonly message: string
  readonly tags: unknown
  readonly meta: Record<string, unknown>
}

interface LogEntry {
  readonly tags?: unknown
  readonly meta?: Record<string, unknown>
}

/** `count` closed hours of `segments` each, ending at the hour before the live tail. */
function ledgerHours(
  deviceId: number,
  profile: string,
  locationId: string,
  count: number,
  segments = 360,
): AvailabilityLedgerHour[] {
  return Array.from({ length: count }, (_, i) => ({
    deviceId,
    profile,
    locationId,
    hourStartMs: CURRENT_HOUR - (i + 1) * HOUR_MS,
    segments,
  }))
}

function harness(overrides: Partial<AvailabilityReportDeps>): {
  readonly deps: AvailabilityReportDeps
  readonly lines: Line[]
} {
  const lines: Line[] = []
  const push =
    (level: 'info' | 'warn') =>
    (message: string, entry?: LogEntry): void => {
      lines.push({ level, message, tags: entry?.tags, meta: entry?.meta ?? {} })
    }
  const deps: AvailabilityReportDeps = {
    devices: () => [7],
    ledgerHours: () => ledgerHours(7, 'high', 'recordings:default', 23),
    refusedHours: () => 0,
    servedProfile: async () => 'high',
    readerSegments: async (_deviceId, _profile, hourStartMs) =>
      hourStartMs < CURRENT_HOUR ? 360 : 40,
    logger: { info: push('info'), warn: push('warn') },
    now: () => NOW,
    ...overrides,
  }
  return { deps, lines }
}

describe('reportAvailability', () => {
  it('one info line per camera, tagged, with reader and ledger side by side', async () => {
    const { deps, lines } = harness({})
    await reportAvailability(deps)
    expect(lines).toHaveLength(1)
    const [line] = lines
    expect(line?.level).toBe('info')
    expect(line?.tags).toEqual({ deviceId: 7 })
    expect(line?.meta).toMatchObject({
      windowHours: 24,
      servedProfile: 'high',
      reader: { hours: 24, segments: 23 * 360 + 40 },
      ledger: [
        { profile: 'high', locationId: 'recordings:default', hours: 23, segments: 23 * 360 },
      ],
      refusedHours: 0,
      ledgerOnlyHours: 0,
      readerOnlyHours: 0,
      duplicatedHours: 0,
    })
  })

  it('warns when the ledger holds the hours and a reader is served nothing', async () => {
    const { deps, lines } = harness({ readerSegments: async () => 0 })
    await reportAvailability(deps)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('warn')
    expect(lines[0]?.tags).toEqual({ deviceId: 7 })
    // The live tail (the current hour and the one before) is not judged.
    expect(lines[0]?.meta).toMatchObject({ reader: { hours: 0, segments: 0 }, ledgerOnlyHours: 22 })
  })

  it('warns when the reader serves a profile the ledger holds nothing under', async () => {
    const { deps, lines } = harness({ servedProfile: async () => null })
    await reportAvailability(deps)
    expect(lines[0]?.level).toBe('warn')
    expect(lines[0]?.meta).toMatchObject({ servedProfile: null, reader: { hours: 0 } })
  })

  it('warns when one hour of a profile is accounted under two locations', async () => {
    const { deps, lines } = harness({
      ledgerHours: () => [
        ...ledgerHours(7, 'high', 'recordings:default', 23),
        ...ledgerHours(7, 'high', 'recordingsLow:default', 5),
      ],
    })
    await reportAvailability(deps)
    expect(lines[0]?.level).toBe('warn')
    expect(lines[0]?.meta).toMatchObject({ duplicatedHours: 5 })
    expect(lines[0]?.meta['ledger']).toEqual([
      { profile: 'high', locationId: 'recordings:default', hours: 23, segments: 23 * 360 },
      { profile: 'high', locationId: 'recordingsLow:default', hours: 5, segments: 5 * 360 },
    ])
  })

  it('warns when a reader is served a closed hour no ledger row names', async () => {
    const { deps, lines } = harness({
      ledgerHours: () => ledgerHours(7, 'high', 'recordings:default', 10),
    })
    await reportAvailability(deps)
    expect(lines[0]?.level).toBe('warn')
    // 24 h window: the live hour and the one before are not judged, 10 are named.
    expect(lines[0]?.meta).toMatchObject({ readerOnlyHours: 13 })
  })

  it('a ledger that did not answer is null, and claims no disagreement', async () => {
    const { deps, lines } = harness({ ledgerHours: () => null, refusedHours: () => null })
    await reportAvailability(deps)
    expect(lines[0]?.level).toBe('info')
    expect(lines[0]?.meta).toMatchObject({ ledger: null, refusedHours: null })
  })

  it('a camera whose reader throws says so, and the others are still reported', async () => {
    const { deps, lines } = harness({
      devices: () => [9, 7],
      ledgerHours: () => [
        ...ledgerHours(7, 'high', 'recordings:default', 23),
        ...ledgerHours(9, 'high', 'recordings:default', 23),
      ],
      servedProfile: async (deviceId) => {
        if (deviceId === 7) throw new Error('EIO')
        return 'high'
      },
    })
    const reports = await reportAvailability(deps)
    expect(lines.map((line) => [line.level, line.tags])).toEqual([
      ['warn', { deviceId: 7 }],
      ['info', { deviceId: 9 }],
    ])
    expect(lines[0]?.meta).toEqual({ error: 'EIO' })
    expect(reports.map((report) => report.deviceId)).toEqual([9])
  })
})
