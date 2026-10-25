import type { ExportRecord } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { describeVariant, formatExpiry, formatRange, mergeLiveExports } from '../export-format'

function makeRecord(overrides: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: 'e1',
    deviceId: 101,
    profile: 'main',
    fromMs: 0,
    toMs: 60_000,
    options: { speed: 1, includeAudio: false, maxLifeMs: 1, deleteAfterDownload: false },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: 0,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: 0,
    createdBy: 'tester',
    error: null,
    ...overrides,
  }
}

describe('describeVariant', () => {
  it('renders regular speed', () => {
    expect(
      describeVariant({ speed: 1, includeAudio: false, maxLifeMs: 1, deleteAfterDownload: false }),
    ).toBe('1×')
  })
  it('appends audio when included', () => {
    expect(
      describeVariant({ speed: 4, includeAudio: true, maxLifeMs: 1, deleteAfterDownload: false }),
    ).toBe('4× + audio')
  })
  it('renders timelapse cadence (always silent)', () => {
    expect(
      describeVariant({
        timelapse: { everyMs: 2000 },
        includeAudio: true,
        maxLifeMs: 1,
        deleteAfterDownload: false,
      }),
    ).toBe('timelapse 2s')
  })
})

describe('formatRange', () => {
  it('uses mm:ss under an hour', () => {
    expect(formatRange(0, 90_000)).toContain('· 1:30')
  })
  it('uses h:mm:ss at/over an hour', () => {
    expect(formatRange(0, 3_661_000)).toContain('· 1:01:01')
  })
})

describe('formatExpiry', () => {
  it('reports expired when past', () => {
    expect(formatExpiry(1_000, 2_000)).toBe('expired')
  })
  it('reports minutes / hours / days', () => {
    const now = 0
    expect(formatExpiry(30 * 60_000, now)).toBe('in 30m')
    expect(formatExpiry(5 * 3_600_000, now)).toBe('in 5h')
    expect(formatExpiry(3 * 86_400_000, now)).toBe('in 3d')
  })
})

describe('mergeLiveExports', () => {
  it('failure event flips row to failed and clears progress', () => {
    const seed = [makeRecord({ id: 'e1', state: 'rendering', progressPct: 40 })]
    const [row] = mergeLiveExports(
      seed,
      new Map(),
      new Map(),
      new Map([['e1', { exportId: 'e1', error: 'ffmpeg exited 1' }]]),
    )
    expect(row!.state).toBe('failed')
    expect(row!.error).toBe('ffmpeg exited 1')
    expect(row!.progressPct).toBeNull()
  })
  it('completion event flips row to ready with fileBytes', () => {
    const seed = [makeRecord({ id: 'e1', state: 'rendering', progressPct: 90 })]
    const [row] = mergeLiveExports(
      seed,
      new Map(),
      new Map([['e1', { exportId: 'e1', fileBytes: 1234 }]]),
      new Map(),
    )
    expect(row!.state).toBe('ready')
    expect(row!.fileBytes).toBe(1234)
    expect(row!.progressPct).toBe(100)
  })
  it('progress event advances an active row', () => {
    const seed = [makeRecord({ id: 'e1', state: 'queued', progressPct: null })]
    const [row] = mergeLiveExports(
      seed,
      new Map([['e1', { exportId: 'e1', progressPct: 55 }]]),
      new Map(),
      new Map(),
    )
    expect(row!.state).toBe('rendering')
    expect(row!.progressPct).toBe(55)
  })
  it('terminal deleted/expired rows ignore live events', () => {
    const seed = [makeRecord({ id: 'e1', state: 'deleted' })]
    const [row] = mergeLiveExports(
      seed,
      new Map([['e1', { exportId: 'e1', progressPct: 10 }]]),
      new Map([['e1', { exportId: 'e1', fileBytes: 9 }]]),
      new Map(),
    )
    expect(row!.state).toBe('deleted')
  })
})
