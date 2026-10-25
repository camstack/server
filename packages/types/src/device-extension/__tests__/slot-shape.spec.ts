/**
 * D663 (amends D648) — a slot has ONE shape, `association`. The `graft`
 * shape ("the host gains a whole capability from other devices") is a
 * COMPOSITION: adding a cap to a device is authored as a composed device,
 * never as an extension slot. So the descriptor carries no `projects`, and
 * the slot view carries no graft switch (`enabled`).
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { ExtensionSlotStateSchema } from '../../capabilities/device-extension.cap.js'
import { EXTENSION_SLOTS } from '../../generated/extension-slots.js'
import type { ExtensionSlotShape } from '../slot-descriptor.js'

describe('extension slot shape', () => {
  it('is association only — a graft is a composition', () => {
    expectTypeOf<ExtensionSlotShape>().toEqualTypeOf<'association'>()
    for (const entry of Object.values(EXTENSION_SLOTS)) {
      expect(entry.descriptor.shape).toBe('association')
      expect('projects' in entry.descriptor).toBe(false)
    }
  })

  it('serves no graft switch and no projected cap on the slot view', () => {
    const fields = Object.keys(ExtensionSlotStateSchema.shape)
    expect(fields).not.toContain('enabled')
    expect(fields).not.toContain('projects')
  })
})
