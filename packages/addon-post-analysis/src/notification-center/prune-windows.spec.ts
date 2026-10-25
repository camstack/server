import { describe, expect, it } from 'vitest'
import {
  PRUNE_SETTING_KEYS,
  PRUNE_WINDOW_DEFAULT_DAYS,
  resolvePruneWindows,
} from './prune-windows.js'

const DAY_MS = 24 * 3600_000

describe('resolvePruneWindows', () => {
  it('falls back to the shipped defaults when nothing is configured', () => {
    const w = resolvePruneWindows({})

    expect(w.outboxMs).toBe(PRUNE_WINDOW_DEFAULT_DAYS.outboxDays * DAY_MS)
    expect(w.timelapseExportMs).toBe(PRUNE_WINDOW_DEFAULT_DAYS.timelapseExportDays * DAY_MS)
    expect(w.artifactShelfMs).toBe(PRUNE_WINDOW_DEFAULT_DAYS.artifactShelfDays * DAY_MS)
    expect(w.summaryMosaicMs).toBe(PRUNE_WINDOW_DEFAULT_DAYS.summaryMosaicDays * DAY_MS)
  })

  it('honours a configured window', () => {
    const w = resolvePruneWindows({ artifactShelfDays: 60 })

    expect(w.artifactShelfMs).toBe(60 * DAY_MS)
    // Untouched knobs keep their default rather than collapsing to the one set.
    expect(w.outboxMs).toBe(PRUNE_WINDOW_DEFAULT_DAYS.outboxDays * DAY_MS)
  })

  it('reads zero as "keep forever", not as "delete everything"', () => {
    // The sign of the catastrophic misreading: 0 must never become a cutoff of
    // `now`, which would delete the whole shelf on the next pass. `null` is the
    // no-cutoff answer every consumer already knows how to skip.
    const w = resolvePruneWindows({ artifactShelfDays: 0 })

    expect(w.artifactShelfMs).toBeNull()
  })

  it('refuses a negative window instead of inventing a future cutoff', () => {
    const w = resolvePruneWindows({ outboxDays: -3 })

    expect(w.outboxMs).toBe(PRUNE_WINDOW_DEFAULT_DAYS.outboxDays * DAY_MS)
  })

  it('refuses a non-finite window', () => {
    // A form that posts an empty string arrives as NaN, and NaN silently
    // poisons every comparison it reaches: `ts < NaN` is false, so the sweep
    // stops deleting and nobody is told.
    const w = resolvePruneWindows({ outboxDays: Number.NaN })

    expect(w.outboxMs).toBe(PRUNE_WINDOW_DEFAULT_DAYS.outboxDays * DAY_MS)
  })

  it('declares every knob it resolves', () => {
    // The list is what the guard reads. A knob resolved but not declared is
    // invisible to the check that it still has a reader.
    expect([...PRUNE_SETTING_KEYS].toSorted()).toEqual(
      Object.keys(PRUNE_WINDOW_DEFAULT_DAYS).toSorted(),
    )
  })
})
