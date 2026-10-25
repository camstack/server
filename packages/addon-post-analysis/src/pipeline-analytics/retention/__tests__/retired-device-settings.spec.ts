/**
 * The D62 settings migration — an operator who set a per-family window must be
 * TOLD, not left to discover it.
 *
 * The change is not neutral: someone who set object retention to 30 days now
 * gets the track's window, which defaults to 7. Deleting the key quietly would
 * make that look like a bug three weeks later. So the sweep announces it once
 * per device, naming the old value and the new effective one, and then removes
 * the key so the announcement cannot repeat forever.
 */
import { describe, expect, it } from 'vitest'
import {
  planRetiredSettingsMigration,
  RETIRED_DEVICE_SETTING_KEYS,
} from '../retired-device-settings.js'

describe('RETIRED_DEVICE_SETTING_KEYS', () => {
  it('names every knob D61 disconnected from its reader', () => {
    expect([...RETIRED_DEVICE_SETTING_KEYS].toSorted()).toEqual([
      'bufferRetentionDays',
      'retentionAudioDays',
      'retentionMotionDays',
      'retentionObjectDays',
    ])
  })
})

describe('planRetiredSettingsMigration', () => {
  it('a device that never touched them needs no migration and gets no log line', () => {
    expect(planRetiredSettingsMigration({})).toBeNull()
    expect(planRetiredSettingsMigration({ trackRetentionDays: 14 })).toBeNull()
  })

  it('reports each retired key WITH the value the operator set', () => {
    const plan = planRetiredSettingsMigration({
      retentionObjectDays: 30,
      retentionAudioDays: 21,
      trackRetentionDays: 7,
    })
    expect(plan).not.toBeNull()
    expect(plan?.retired).toEqual([
      { key: 'retentionObjectDays', was: 30 },
      { key: 'retentionAudioDays', was: 21 },
    ])
  })

  it('reports the window that governs now, so the log line carries both numbers', () => {
    const plan = planRetiredSettingsMigration({
      retentionObjectDays: 30,
      retentionMode: 'custom',
      trackRetentionDays: 3,
    })
    expect(plan?.nowGovernedBy).toEqual({ retentionMode: 'custom', trackRetentionDays: 3 })
  })

  it('falls back to the defaults for the "now" half when the device set no window', () => {
    const plan = planRetiredSettingsMigration({ retentionMotionDays: 14 })
    expect(plan?.nowGovernedBy).toEqual({
      retentionMode: 'follow-recordings',
      trackRetentionDays: 7,
    })
  })

  it('the patch UNSETS every retired key and touches nothing else', () => {
    const plan = planRetiredSettingsMigration({
      retentionObjectDays: 30,
      bufferRetentionDays: 3,
      trackRetentionDays: 14,
    })
    expect(plan?.patch).toEqual({ retentionObjectDays: undefined, bufferRetentionDays: undefined })
    // The keys are PRESENT with an undefined value — that is what makes the
    // store merge + JSON round-trip drop them, rather than preserving a null.
    expect(Object.keys(plan?.patch ?? {}).toSorted()).toEqual([
      'bufferRetentionDays',
      'retentionObjectDays',
    ])
  })

  it('is idempotent: applying the patch makes the next plan null', () => {
    const raw: Record<string, unknown> = { retentionObjectDays: 30, trackRetentionDays: 7 }
    const plan = planRetiredSettingsMigration(raw)
    if (plan === null) throw new Error('expected a migration plan')
    const after: Record<string, unknown> = { ...raw, ...plan.patch }
    // The store drops undefined values on write; simulate the round trip.
    for (const [k, v] of Object.entries(after)) if (v === undefined) delete after[k]
    expect(after).toEqual({ trackRetentionDays: 7 })
    expect(planRetiredSettingsMigration(after)).toBeNull()
  })

  it('a key present but explicitly undefined is already gone — no second announcement', () => {
    expect(planRetiredSettingsMigration({ retentionObjectDays: undefined })).toBeNull()
  })
})
