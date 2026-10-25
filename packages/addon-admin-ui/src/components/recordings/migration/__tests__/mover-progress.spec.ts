/**
 * The rules a progress reading has to obey, pinned away from the React tree.
 *
 * All three are ways a well-meaning line lies: a missing denominator rendered
 * as 0 %, a rate divided by a zero-length window, and an ETA extrapolated from
 * a mover that has moved nothing.
 */
import type { StorageMigrationMoveProgress } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { describeProgress, formatDuration, progressSummary } from '../mover-progress'

function at(
  filesMoved: number,
  filesTotal: number | null,
  elapsedMs: number,
): StorageMigrationMoveProgress {
  return {
    filesMoved,
    filesTotal,
    bytesMoved: filesMoved * 700_000,
    startedAt: 1_000_000,
    observedAt: 1_000_000 + elapsedMs,
  }
}

describe('describeProgress', () => {
  it('counts against the archive denominator', () => {
    const line = describeProgress(at(3_588, 136_885, 600_000))
    expect(line.counted).toBe('3,588 / 136,885 files')
    expect(line.fraction).toBeCloseTo(3_588 / 136_885, 6)
  })

  it('refuses a fraction when the denominator is unknown', () => {
    // A windowed footage job and a node with no ledger both genuinely cannot
    // say M (D295). Rendering 0 % there would read as "nothing has happened",
    // and rendering 100 % would read as "done".
    const line = describeProgress(at(500, null, 600_000))
    expect(line.counted).toBe('500 files')
    expect(line.fraction).toBeNull()
    expect(line.eta).toBeNull()
  })

  it('refuses a fraction when the denominator is zero', () => {
    expect(describeProgress(at(0, 0, 600_000)).fraction).toBeNull()
  })

  it('reports the byte rate over the hub-side window', () => {
    // 3 588 × 700 000 B ≈ 2.51 GB over 600 s ≈ 4.0 MB/s.
    expect(describeProgress(at(3_588, 136_885, 600_000)).rate).toBe('4.0 MB/s')
  })

  it('reports no rate before anything measurable has happened', () => {
    // Zero elapsed would divide by zero; zero moved would report a stall that
    // has not happened yet.
    expect(describeProgress(at(10, 100, 0)).rate).toBeNull()
    expect(describeProgress(at(0, 100, 600_000)).rate).toBeNull()
    expect(describeProgress(at(0, 100, 600_000)).eta).toBeNull()
  })

  it('estimates the remaining time from the FILE rate', () => {
    // 133 297 files left at 3 588 per 600 s ≈ 22 292 s ≈ 6h 12m.
    expect(describeProgress(at(3_588, 136_885, 600_000)).eta).toBe('~6h 12m left')
  })

  it('drops the estimate once the denominator is reached', () => {
    expect(describeProgress(at(100, 100, 600_000)).eta).toBeNull()
  })

  it('joins only the parts it can honestly say', () => {
    // No rate and no ETA: nothing measurable has elapsed. Binary units, as
    // everywhere else in this UI (350 MB decimal = 334 MB binary).
    expect(progressSummary(at(500, null, 0))).toBe('500 files · 334 MB moved')
  })
})

describe('formatDuration', () => {
  it('renders hours, minutes and seconds coarsely', () => {
    expect(formatDuration(22_292_000)).toBe('6h 12m')
    expect(formatDuration(150_000)).toBe('2m 30s')
    expect(formatDuration(45_000)).toBe('45s')
  })

  it('never renders a non-finite estimate as a number', () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})
