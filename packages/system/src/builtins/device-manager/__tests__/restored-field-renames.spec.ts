/**
 * `restoredFieldRenames` (#459): `alarm-panel.requiresCode` became
 * `codeRequired`. A row persisted before the rename still carries the old key;
 * the boot seed reads it ONCE into the new name, so no reader meets the old key
 * and a panel that demanded a PIN still demands one after the upgrade.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeStatePolicy } from '@camstack/types'
import { restoredPart } from '../runtime-state-persist-gate.js'
import { harness } from './mirror-harness.js'

// The policy `npm run codegen` projects from `alarm-panel.cap.ts` (pinned in
// packages/types `runtime-state-renames.spec.ts`).
const ALARM: RuntimeStatePolicy = {
  durability: 'restored',
  volatileFields: ['lastChangedAt'],
  renamedFields: { requiresCode: 'codeRequired' },
}
const policyFor = (cap: string): RuntimeStatePolicy =>
  cap === 'alarm-panel' ? ALARM : { durability: 'session', volatileFields: [] }

const DEVICE = 302

const LEGACY_ALARM_ROW = {
  state: 'armed_away',
  targetMode: 'away',
  availableModes: ['home', 'away'],
  requiresCode: true,
  lastChangedAt: 5,
}

describe('restoredFieldRenames — alarm-panel requiresCode → codeRequired', () => {
  it('the boot seed upgrades a pre-rename slice, keeping its value', () => {
    const after = harness(policyFor)
    after.mirror.seedMirror(DEVICE, { 'alarm-panel': LEGACY_ALARM_ROW })
    const seeded = after.mirror.capSlice(DEVICE, 'alarm-panel')
    expect(seeded).toEqual({
      state: 'armed_away',
      targetMode: 'away',
      availableModes: ['home', 'away'],
      codeRequired: true,
      lastChangedAt: 5,
    })
  })

  it('a slice that already carries the new key keeps it and drops the old one', () => {
    const out = restoredPart(
      { state: 'disarmed', codeRequired: null, requiresCode: true },
      ALARM,
    )
    expect(out).toEqual({ state: 'disarmed', codeRequired: null })
  })

  it('a cap without renames is untouched', () => {
    const slice = { state: 'locked', requiresCode: true }
    expect(restoredPart(slice, { durability: 'restored', volatileFields: [] })).toEqual(slice)
  })
})
