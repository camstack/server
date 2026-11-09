/**
 * The one `notifiers` action the Notification Center viewer still rides: the add form's kind
 * catalogue. The row actions (list/upsert/delete/switch/test) are gone, so the surface is pinned
 * to exactly this one name.
 */
import type { TargetKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeNcTargetHandlers, ncTargetActions } from '../nc-target-actions.js'

describe('nc-target-actions', () => {
  it('declares only the kind catalogue (no per-target action survives)', () => {
    expect(Object.keys(ncTargetActions)).toEqual(['nc.listTargetKinds'])
  })

  it('answers the provider kind list', async () => {
    const kinds: TargetKind[] = []
    const handlers = makeNcTargetHandlers({ provider: { listTargetKinds: async () => kinds } })
    await expect(handlers['nc.listTargetKinds']({})).resolves.toEqual({ kinds })
  })
})
