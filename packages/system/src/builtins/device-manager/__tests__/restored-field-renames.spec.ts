/**
 * `restoredFieldRenames` (#459): `alarm-panel.requiresCode` became
 * `codeRequired`. A row persisted before the rename still carries the old key;
 * the boot seed reads it ONCE into the new name, so no reader meets the old key
 * and a panel that demanded a PIN still demands one after the upgrade.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatePolicy } from '@dominevo/types'
import { loadRuntimeState } from '../device-meta-actions.js'
import type { ProviderContext } from '../device-provider-context.js'
import { restoredPart } from '../runtime-state-persist-gate.js'
import { flushDebounce, harness, NOT_LOADED_INDEX } from './mirror-harness.js'

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

const UPGRADED_ALARM_ROW = {
  state: 'armed_away',
  targetMode: 'away',
  availableModes: ['home', 'away'],
  codeRequired: true,
  lastChangedAt: 5,
}

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
    const out = restoredPart({ state: 'disarmed', codeRequired: null, requiresCode: true }, ALARM)
    expect(out).toEqual({ state: 'disarmed', codeRequired: null })
  })

  it('a cap without renames is untouched', () => {
    const slice = { state: 'locked', requiresCode: true }
    expect(restoredPart(slice, { durability: 'restored', volatileFields: [] })).toEqual(slice)
  })

  // The row is REWRITTEN once under the new name, so the old key leaves the disk
  // and the rename entry can be retired once every row has been through a boot.
  describe('the upgraded row is written back once', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('a boot read of a pre-rename row rewrites it without the old key', async () => {
      vi.useFakeTimers()
      const h = harness(policyFor)
      h.rows.set(DEVICE, { 'alarm-panel': LEGACY_ALARM_ROW })
      await h.mirror.ensureSeeded(DEVICE, h.settings, NOT_LOADED_INDEX)
      await flushDebounce()
      expect(h.writes).toEqual([{ deviceId: DEVICE, blob: { 'alarm-panel': UPGRADED_ALARM_ROW } }])
      expect(h.logs.some((l) => l.message.includes('renamed field'))).toBe(true)
    })

    it('a row already under the new name is not rewritten', async () => {
      vi.useFakeTimers()
      const h = harness(policyFor)
      h.rows.set(DEVICE, { 'alarm-panel': UPGRADED_ALARM_ROW })
      await h.mirror.ensureSeeded(DEVICE, h.settings, NOT_LOADED_INDEX)
      await flushDebounce()
      expect(h.writes).toEqual([])
    })

    it('the provider-load seed (loadRuntimeState) rewrites it too', async () => {
      vi.useFakeTimers()
      const h = harness(policyFor)
      const pctx = {
        metaStore: { resolvePersistedById: async () => ({ id: DEVICE }) },
        settings: h.settings,
        host: {
          seedMirrorFromRow: (id: number, row: Record<string, unknown>) =>
            h.mirror.seedMirrorFromRow(id, row, h.settings),
        },
      } as unknown as ProviderContext
      h.rows.set(DEVICE, { 'alarm-panel': LEGACY_ALARM_ROW })
      // The worker is handed the upgraded slice too — it never meets the old key.
      expect(await loadRuntimeState(pctx, { deviceId: DEVICE })).toEqual({
        'alarm-panel': UPGRADED_ALARM_ROW,
      })
      await flushDebounce()
      expect(h.writes).toEqual([{ deviceId: DEVICE, blob: { 'alarm-panel': UPGRADED_ALARM_ROW } }])
    })
  })
})
