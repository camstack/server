/**
 * The native-frame LEASE knobs are cluster-wide orchestrator settings, not env
 * vars.
 *
 * They govern how much system RAM every decode worker holds in retained
 * native-resolution frames, so the two things worth pinning are the BOUNDS (a
 * junk value travels into a forked child where it becomes a 0-length or
 * unbounded retention window) and the SCOPE (one value for the cluster — the
 * lease decides whether a stored crop is native or the ≤640 fallback, which
 * must not depend on which node the balancer happened to pick).
 */

import type { ConfigField, ConfigSection } from '@camstack/types'
import {
  DEFAULT_NATIVE_LEASE_SETTINGS,
  NATIVE_LEASE_ACTIVITY_KEY,
  NATIVE_LEASE_ADMISSION_KEY,
  NATIVE_LEASE_BUDGET_KEY,
  NATIVE_LEASE_HOLD_KEY,
  NATIVE_LEASE_SCENE_BUDGET_KEY,
  NATIVE_LEASE_SECTION_ID,
  NATIVE_LEASE_TILE_BUDGET_KEY,
  pickNativeLeaseOverride,
  readNativeLeaseOverride,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildGlobalSettingsSections } from '../settings-ui-schemas.js'

function sections(): ConfigSection[] {
  return buildGlobalSettingsSections({ fpsMinThresholdDefault: 0 })
}

function leaseSection(): ConfigSection {
  const found = sections().find((s) => s.id === NATIVE_LEASE_SECTION_ID)
  expect(found).toBeDefined()
  return found!
}

/**
 * `ConfigField` is a wide union whose separator/text variants carry no
 * `default`/`min`/`perNode`. Widen to an index signature instead of casting —
 * the assertions are about what the schema OBJECT carries, not about which
 * union member TypeScript picked.
 */
function widen(f: ConfigField): Readonly<Record<string, unknown>> {
  const entries: Readonly<Record<string, unknown>> = { ...f }
  return entries
}

function field(key: string): Readonly<Record<string, unknown>> {
  const found: ConfigField | undefined = leaseSection().fields.find((f) => f.key === key)
  expect(found).toBeDefined()
  return found === undefined ? {} : widen(found)
}

describe('native-lease global settings section', () => {
  it('exposes exactly the six lease knobs', () => {
    expect(leaseSection().fields.map((f) => f.key)).toEqual([
      NATIVE_LEASE_HOLD_KEY,
      NATIVE_LEASE_TILE_BUDGET_KEY,
      NATIVE_LEASE_SCENE_BUDGET_KEY,
      NATIVE_LEASE_BUDGET_KEY,
      NATIVE_LEASE_ACTIVITY_KEY,
      NATIVE_LEASE_ADMISSION_KEY,
    ])
  })

  it('defaults reproduce the shipped decode-worker constants', () => {
    expect(field(NATIVE_LEASE_HOLD_KEY)['default']).toBe(DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames)
    expect(field(NATIVE_LEASE_BUDGET_KEY)['default']).toBe(DEFAULT_NATIVE_LEASE_SETTINGS.budgetMb)
    expect(field(NATIVE_LEASE_ACTIVITY_KEY)['default']).toBe(
      DEFAULT_NATIVE_LEASE_SETTINGS.activityMs,
    )
    expect(field(NATIVE_LEASE_ADMISSION_KEY)['default']).toBe(
      DEFAULT_NATIVE_LEASE_SETTINGS.admission,
    )
    // The rung that decides whether a late FULL-FRAME request has anything to
    // land on. A slider whose default disagrees with the worker constant means
    // the form silently retunes every cluster that opens it.
    expect(field(NATIVE_LEASE_SCENE_BUDGET_KEY)['default']).toBe(
      DEFAULT_NATIVE_LEASE_SETTINGS.sceneBudgetMb,
    )
  })

  it('offers admission as a two-way choice, not a slider', () => {
    const admission = field(NATIVE_LEASE_ADMISSION_KEY)
    expect(admission['type']).toBe('select')
    const options = admission['options']
    expect(Array.isArray(options)).toBe(true)
    expect(
      (Array.isArray(options) ? options : []).map((o) => (o as { value: string }).value),
    ).toEqual(['all', 'inferred'])
  })

  it('bounds each slider to the range the worker can honour', () => {
    expect(field(NATIVE_LEASE_HOLD_KEY)['min']).toBe(1)
    expect(field(NATIVE_LEASE_HOLD_KEY)['max']).toBe(64)
    expect(field(NATIVE_LEASE_TILE_BUDGET_KEY)['min']).toBe(0)
    expect(field(NATIVE_LEASE_TILE_BUDGET_KEY)['max']).toBe(1024)
    expect(field(NATIVE_LEASE_BUDGET_KEY)['min']).toBe(0)
    expect(field(NATIVE_LEASE_BUDGET_KEY)['max']).toBe(4096)
    expect(field(NATIVE_LEASE_ACTIVITY_KEY)['min']).toBe(0)
    expect(field(NATIVE_LEASE_ACTIVITY_KEY)['max']).toBe(120_000)
  })

  it('is cluster-wide: no knob is per-node', () => {
    for (const f of leaseSection().fields) {
      expect(widen(f)['perNode']).toBeUndefined()
    }
  })

  it('states the RAM cost in every description', () => {
    for (const key of [
      NATIVE_LEASE_HOLD_KEY,
      NATIVE_LEASE_TILE_BUDGET_KEY,
      NATIVE_LEASE_BUDGET_KEY,
      NATIVE_LEASE_ACTIVITY_KEY,
      NATIVE_LEASE_ADMISSION_KEY,
    ]) {
      const description = field(key)['description']
      expect(typeof description).toBe('string')
      expect(String(description).length).toBeGreaterThan(80)
    }
  })
})

describe('readNativeLeaseOverride', () => {
  it('reads a fully-configured record', () => {
    expect(
      readNativeLeaseOverride({
        [NATIVE_LEASE_HOLD_KEY]: 24,
        [NATIVE_LEASE_BUDGET_KEY]: 512,
        [NATIVE_LEASE_ACTIVITY_KEY]: 30_000,
      }),
    ).toEqual({ holdFrames: 24, budgetMb: 512, activityMs: 30_000 })
  })

  it('OMITS an unset knob rather than defaulting it — the env override must still apply', () => {
    expect(readNativeLeaseOverride({})).toEqual({})
    expect(readNativeLeaseOverride({ [NATIVE_LEASE_HOLD_KEY]: 24 })).toEqual({
      holdFrames: 24,
    })
  })

  // `addon-settings.getGlobalSettings` HYDRATES an unstored field with the
  // schema default (verified live: a cluster that never opened the form reports
  // nativeLeaseTtlMs=1200). Reporting that as "set" would retire the env
  // override on every cluster the day this shipped, so the default counts as
  // "no preference expressed".
  it('treats a knob AT the shipped default as unset — hydration cannot distinguish it', () => {
    expect(
      readNativeLeaseOverride({
        [NATIVE_LEASE_HOLD_KEY]: DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames,
        [NATIVE_LEASE_BUDGET_KEY]: DEFAULT_NATIVE_LEASE_SETTINGS.budgetMb,
        [NATIVE_LEASE_ACTIVITY_KEY]: DEFAULT_NATIVE_LEASE_SETTINGS.activityMs,
      }),
    ).toEqual({})
  })

  it('a default on one knob does not hide a real choice on another', () => {
    expect(
      readNativeLeaseOverride({
        [NATIVE_LEASE_HOLD_KEY]: DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames,
        [NATIVE_LEASE_BUDGET_KEY]: 512,
      }),
    ).toEqual({ budgetMb: 512 })
  })

  it('OMITS an out-of-bounds or junk knob rather than clamping it', () => {
    expect(readNativeLeaseOverride({ [NATIVE_LEASE_HOLD_KEY]: 0 })).toEqual({})
    expect(readNativeLeaseOverride({ [NATIVE_LEASE_HOLD_KEY]: 99_999 })).toEqual({})
    expect(readNativeLeaseOverride({ [NATIVE_LEASE_HOLD_KEY]: 'fast' })).toEqual({})
    expect(readNativeLeaseOverride({ [NATIVE_LEASE_BUDGET_KEY]: -1 })).toEqual({})
    expect(readNativeLeaseOverride({ [NATIVE_LEASE_ACTIVITY_KEY]: 999_999 })).toEqual({})
  })

  it('a junk knob never discards a valid sibling', () => {
    expect(
      readNativeLeaseOverride({
        [NATIVE_LEASE_HOLD_KEY]: 'nonsense',
        [NATIVE_LEASE_BUDGET_KEY]: 256,
      }),
    ).toEqual({ budgetMb: 256 })
  })

  it('accepts 0 for budget (lease OFF) and 0 for activity (gate OFF)', () => {
    expect(readNativeLeaseOverride({ [NATIVE_LEASE_BUDGET_KEY]: 0 })).toEqual({
      budgetMb: 0,
    })
    expect(readNativeLeaseOverride({ [NATIVE_LEASE_ACTIVITY_KEY]: 0 })).toEqual({ activityMs: 0 })
  })
})

describe('pickNativeLeaseOverride', () => {
  it('walks every section, not just the lease one — a rename must not revert the cluster', () => {
    const view = {
      sections: [
        { fields: [{ key: 'unrelated', value: 7 }] },
        { fields: [{ key: NATIVE_LEASE_HOLD_KEY, value: 24 }] },
      ],
    }
    expect(pickNativeLeaseOverride(view)).toEqual({ holdFrames: 24 })
  })

  it('a null payload (addon mid-boot) means "operator set nothing"', () => {
    expect(pickNativeLeaseOverride(null)).toEqual({})
  })

  // The scene budget travels the SAME hydrated-payload walk as the others, and
  // a key missing from that walk's list is invisible: the form would accept the
  // value, the worker would never see it, and both sides would look correct.
  // 0 is the value that matters most here — it turns the rung OFF.
  it('carries the scene budget, including the 0 that disables the rung', () => {
    expect(
      pickNativeLeaseOverride({
        sections: [{ fields: [{ key: NATIVE_LEASE_SCENE_BUDGET_KEY, value: 96 }] }],
      }),
    ).toEqual({ sceneBudgetMb: 96 })
    expect(
      pickNativeLeaseOverride({
        sections: [{ fields: [{ key: NATIVE_LEASE_SCENE_BUDGET_KEY, value: 0 }] }],
      }),
    ).toEqual({ sceneBudgetMb: 0 })
  })

  it('a payload hydrated entirely with defaults reads as "operator set nothing"', () => {
    expect(
      pickNativeLeaseOverride({
        sections: [
          {
            fields: [
              { key: NATIVE_LEASE_HOLD_KEY, value: DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames },
              { key: NATIVE_LEASE_BUDGET_KEY, value: DEFAULT_NATIVE_LEASE_SETTINGS.budgetMb },
              { key: NATIVE_LEASE_ACTIVITY_KEY, value: DEFAULT_NATIVE_LEASE_SETTINGS.activityMs },
            ],
          },
        ],
      }),
    ).toEqual({})
  })

  it('a hydrated field with no value is unset, not zero', () => {
    expect(
      pickNativeLeaseOverride({
        sections: [{ fields: [{ key: NATIVE_LEASE_HOLD_KEY }] }],
      }),
    ).toEqual({})
  })
})
