/**
 * Precedence for the native-lease knobs: operator SETTING > env var > default.
 *
 * Resolved in the PARENT (the pipeline-runner), once per session, and carried
 * to the decode worker on its `start` message (D453). The env vars predate the
 * settings and are kept as an emergency/dev override, so the resolution order
 * has to be pinned rather than assumed — and the resolved SOURCE has to survive
 * into the log line, because "the worker is holding 24 frames" and "the
 * operator asked for 24" are different claims and only one of them is
 * checkable from a log.
 */

import { DEFAULT_NATIVE_LEASE_SETTINGS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NATIVE_LEASE_ENV_VARS, resolveNativeLeaseKnobs } from '../native-lease-config.js'
import { formatNativeLeaseKnobs, isWorkerLeaseKnobs } from '../native-lease-knobs.js'

describe('resolveNativeLeaseKnobs', () => {
  it('falls back to the shipped defaults with an empty environment and nothing set', () => {
    const resolved = resolveNativeLeaseKnobs({}, {})
    expect(resolved.values).toEqual(DEFAULT_NATIVE_LEASE_SETTINGS)
    expect(resolved.sources).toEqual({
      holdFrames: 'default',
      budgetMb: 'default',
      activityMs: 'default',
      admission: 'default',
      tileBudgetMb: 'default',
      sceneBudgetMb: 'default',
    })
  })

  it('an env var overrides the default', () => {
    const resolved = resolveNativeLeaseKnobs({ [NATIVE_LEASE_ENV_VARS.holdFrames]: '16' }, {})
    expect(resolved.values.holdFrames).toBe(16)
    expect(resolved.sources.holdFrames).toBe('env')
    expect(resolved.sources.budgetMb).toBe('default')
  })

  it('the operator SETTING wins over the env var', () => {
    const resolved = resolveNativeLeaseKnobs(
      { [NATIVE_LEASE_ENV_VARS.holdFrames]: '16' },
      { holdFrames: 24 },
    )
    expect(resolved.values.holdFrames).toBe(24)
    expect(resolved.sources.holdFrames).toBe('setting')
  })

  it('resolves each knob independently — a setting on one leaves the others on env/default', () => {
    const resolved = resolveNativeLeaseKnobs(
      { [NATIVE_LEASE_ENV_VARS.budgetMb]: '256' },
      { holdFrames: 24 },
    )
    expect(resolved.values).toEqual({
      holdFrames: 24,
      budgetMb: 256,
      activityMs: DEFAULT_NATIVE_LEASE_SETTINGS.activityMs,
      admission: DEFAULT_NATIVE_LEASE_SETTINGS.admission,
      tileBudgetMb: DEFAULT_NATIVE_LEASE_SETTINGS.tileBudgetMb,
      sceneBudgetMb: DEFAULT_NATIVE_LEASE_SETTINGS.sceneBudgetMb,
    })
    expect(resolved.sources).toEqual({
      admission: 'default',
      holdFrames: 'setting',
      budgetMb: 'env',
      activityMs: 'default',
      tileBudgetMb: 'default',
      sceneBudgetMb: 'default',
    })
  })

  it('an out-of-bounds SETTING falls through to the env var, not to a clamped value', () => {
    const resolved = resolveNativeLeaseKnobs(
      { [NATIVE_LEASE_ENV_VARS.holdFrames]: '16' },
      { holdFrames: 999 },
    )
    expect(resolved.values.holdFrames).toBe(16)
    expect(resolved.sources.holdFrames).toBe('env')
  })

  it('a junk env var falls through to the default', () => {
    const resolved = resolveNativeLeaseKnobs({ [NATIVE_LEASE_ENV_VARS.holdFrames]: 'soon' }, {})
    expect(resolved.values.holdFrames).toBe(DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames)
    expect(resolved.sources.holdFrames).toBe('default')
  })

  it('honours the two meaningful zeroes: budget 0 (lease off) and activity 0 (gate off)', () => {
    const resolved = resolveNativeLeaseKnobs(
      { [NATIVE_LEASE_ENV_VARS.activityMs]: '0' },
      { budgetMb: 0 },
    )
    expect(resolved.values.budgetMb).toBe(0)
    expect(resolved.sources.budgetMb).toBe('setting')
    expect(resolved.values.activityMs).toBe(0)
    expect(resolved.sources.activityMs).toBe('env')
  })

  it('a hold env var of 0 is rejected (a worker that holds nothing can crop nothing)', () => {
    const resolved = resolveNativeLeaseKnobs({ [NATIVE_LEASE_ENV_VARS.holdFrames]: '0' }, {})
    expect(resolved.values.holdFrames).toBe(DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames)
    expect(resolved.sources.holdFrames).toBe('default')
  })

  // The scene budget is the one knob that decides whether a late FULL-FRAME
  // request has any rung at all. A knob missing from one of the maps resolves
  // silently to its default and the operator's choice never arrives, so it
  // gets its own end-to-end assertion rather than riding the others.
  it('carries the scene budget through the whole precedence chain', () => {
    const fromDefault = resolveNativeLeaseKnobs({}, {})
    expect(fromDefault.values.sceneBudgetMb).toBe(DEFAULT_NATIVE_LEASE_SETTINGS.sceneBudgetMb)
    expect(fromDefault.sources.sceneBudgetMb).toBe('default')

    const fromEnv = resolveNativeLeaseKnobs({ [NATIVE_LEASE_ENV_VARS.sceneBudgetMb]: '16' }, {})
    expect(fromEnv.values.sceneBudgetMb).toBe(16)
    expect(fromEnv.sources.sceneBudgetMb).toBe('env')

    const fromSetting = resolveNativeLeaseKnobs(
      { [NATIVE_LEASE_ENV_VARS.sceneBudgetMb]: '16' },
      { sceneBudgetMb: 96 },
    )
    expect(fromSetting.values.sceneBudgetMb).toBe(96)
    expect(fromSetting.sources.sceneBudgetMb).toBe('setting')

    // 0 is a real choice — it DISABLES the rung — and must survive the trip.
    const disabled = resolveNativeLeaseKnobs({}, { sceneBudgetMb: 0 })
    expect(disabled.values.sceneBudgetMb).toBe(0)
    expect(disabled.sources.sceneBudgetMb).toBe('setting')
  })

  it('produces exactly the shape the worker accepts on its start message', () => {
    expect(isWorkerLeaseKnobs(resolveNativeLeaseKnobs({}, { holdFrames: 24 }))).toBe(true)
  })
})

describe('resolveNativeLeaseKnobs — the admission knob', () => {
  it('follows the same setting > env > default precedence as the numeric knobs', () => {
    expect(resolveNativeLeaseKnobs({}, {}).values.admission).toBe(
      DEFAULT_NATIVE_LEASE_SETTINGS.admission,
    )
    const fromEnv = resolveNativeLeaseKnobs({ [NATIVE_LEASE_ENV_VARS.admission]: 'all' }, {})
    expect(fromEnv.values.admission).toBe('all')
    expect(fromEnv.sources.admission).toBe('env')
    const fromSetting = resolveNativeLeaseKnobs(
      { [NATIVE_LEASE_ENV_VARS.admission]: 'all' },
      { admission: 'inferred' },
    )
    expect(fromSetting.values.admission).toBe('inferred')
    expect(fromSetting.sources.admission).toBe('setting')
  })

  it('falls THROUGH an unrecognised word rather than guessing at it', () => {
    const resolved = resolveNativeLeaseKnobs({ [NATIVE_LEASE_ENV_VARS.admission]: 'some' }, {})
    expect(resolved.values.admission).toBe(DEFAULT_NATIVE_LEASE_SETTINGS.admission)
    expect(resolved.sources.admission).toBe('default')
  })

  it('names the admission knob and its source in the spawn line', () => {
    const line = formatNativeLeaseKnobs(resolveNativeLeaseKnobs({}, { admission: 'all' }))
    expect(line).toContain('admission=all source=setting')
  })
})

describe('formatNativeLeaseKnobs', () => {
  it('names the effective value AND its source for every knob', () => {
    const line = formatNativeLeaseKnobs(resolveNativeLeaseKnobs({}, { holdFrames: 24 }))
    expect(line).toContain('holdFrames=24')
    expect(line).toContain('source=setting')
    expect(line).toContain('budgetMb=1024')
    expect(line).toContain('activityMs=15000')
    expect(line).toContain('tileBudgetMb=64')
    expect(line).toContain('sceneBudgetMb=48')
  })
})
