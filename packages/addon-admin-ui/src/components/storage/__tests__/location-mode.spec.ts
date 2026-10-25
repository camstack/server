/**
 * The four-way state, and the legacy fold that must not make footage vanish.
 */
import { isStorageLocationMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  LOCATION_MODE_CHOICES,
  locationModeChoice,
  modeAcceptsWrites,
  modeBlockedReasons,
  modeChangeBlocked,
  modeRequiresConfirmation,
  modeServesReads,
  resolveLocationMode,
} from '../location-mode'

const SSD = { id: 'recordings:ssd', config: { basePath: '/recordings' } }
const HDD = { id: 'recordings:hdd', config: { basePath: '/mnt/hdd' } }

describe('resolveLocationMode', () => {
  it('reads a stamped mode verbatim', () => {
    expect(resolveLocationMode({ mode: 'disabled', config: {} })).toBe('disabled')
    expect(resolveLocationMode({ mode: 'drain', config: {} })).toBe('drain')
  })

  it('rejects a mode string that is not one of the four', () => {
    // The field is typed, so a value outside the union can only arrive off the
    // wire — which is where the guard earns its place. Asserted on the guard
    // rather than by casting a bad object into the resolver: a cast here would
    // be exactly the lie the guard exists to catch.
    expect(isStorageLocationMode('paused')).toBe(false)
    expect(isStorageLocationMode(undefined)).toBe(false)
    for (const mode of LOCATION_MODE_CHOICES) expect(isStorageLocationMode(mode.mode)).toBe(true)
  })

  it('folds a legacy row with no flags into ACTIVE', () => {
    expect(resolveLocationMode({ config: { basePath: '/recordings' } })).toBe('active')
    expect(resolveLocationMode({ enabled: true, config: {} })).toBe('active')
  })

  it('folds the legacy drain flag into READ-ONLY, never into a deleting state', () => {
    expect(resolveLocationMode({ enabled: false, config: { readOnly: true } })).toBe('readonly')
    expect(resolveLocationMode({ enabled: true, config: { readOnly: true } })).toBe('readonly')
  })

  it('folds a row that was merely out of the write set into READ-ONLY', () => {
    expect(resolveLocationMode({ enabled: false, config: {} })).toBe('readonly')
  })

  it('never folds anything legacy into DISABLED — no old row hid its footage', () => {
    const legacyRows = [
      { config: {} },
      { enabled: false, config: {} },
      { enabled: false, config: { readOnly: true } },
      { enabled: true, config: { readOnly: true } },
    ]
    for (const row of legacyRows) expect(resolveLocationMode(row)).not.toBe('disabled')
  })
})

describe('the mode table', () => {
  it('lets only ACTIVE take writes', () => {
    expect(modeAcceptsWrites('active')).toBe(true)
    expect(modeAcceptsWrites('readonly')).toBe(false)
    expect(modeAcceptsWrites('drain')).toBe(false)
    expect(modeAcceptsWrites('disabled')).toBe(false)
  })

  it('serves reads everywhere but DISABLED', () => {
    expect(modeServesReads('active')).toBe(true)
    expect(modeServesReads('readonly')).toBe(true)
    expect(modeServesReads('drain')).toBe(true)
    expect(modeServesReads('disabled')).toBe(false)
  })

  it('carries a consequence line for every choice', () => {
    expect(LOCATION_MODE_CHOICES).toHaveLength(4)
    for (const choice of LOCATION_MODE_CHOICES)
      expect(choice.consequence.length).toBeGreaterThan(20)
  })

  it('says, in the DISABLED choice itself, that the footage leaves the timeline', () => {
    expect(locationModeChoice('disabled').consequence).toMatch(/timeline/i)
    expect(locationModeChoice('disabled').consequence).toMatch(/nothing is deleted/i)
  })

  it('confirms DISABLED and only DISABLED', () => {
    expect(modeRequiresConfirmation('disabled')).toBe(true)
    expect(modeRequiresConfirmation('active')).toBe(false)
    expect(modeRequiresConfirmation('readonly')).toBe(false)
    expect(modeRequiresConfirmation('drain')).toBe(false)
  })
})

describe('modeChangeBlocked', () => {
  it('refuses moving the LAST writable location of a type out of active', () => {
    for (const next of ['readonly', 'drain', 'disabled'] as const) {
      const verdict = modeChangeBlocked(SSD, [SSD], next)
      expect(verdict.blocked).toBe(true)
      expect(verdict.reason).toMatch(/last location of its type/i)
    }
  })

  it('allows it when another location of the type still takes writes', () => {
    expect(modeChangeBlocked(SSD, [SSD, HDD], 'drain').blocked).toBe(false)
  })

  it('counts only ACTIVE siblings as writable', () => {
    const drained = { ...HDD, config: { ...HDD.config, readOnly: true } }
    expect(modeChangeBlocked(SSD, [SSD, drained], 'drain').blocked).toBe(true)
  })

  it('never blocks a move back to active', () => {
    const drained = { ...SSD, config: { ...SSD.config, readOnly: true } }
    expect(modeChangeBlocked(drained, [drained], 'active').blocked).toBe(false)
  })

  it('never blocks a location that is already out of the write set', () => {
    const frozen = { ...SSD, enabled: false, config: SSD.config }
    expect(modeChangeBlocked(frozen, [frozen], 'disabled').blocked).toBe(false)
  })
})

describe('modeBlockedReasons', () => {
  it('answers for all four modes so the refused choice still renders', () => {
    const reasons = modeBlockedReasons(SSD, [SSD])
    expect(reasons.active).toBe('')
    expect(reasons.readonly).not.toBe('')
    expect(reasons.drain).not.toBe('')
    expect(reasons.disabled).not.toBe('')
  })
})
