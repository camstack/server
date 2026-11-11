/**
 * The `nc.*` action the Notification Center viewer still calls: the add form's kind catalogue.
 * A user's own targets go through `integration-instances` (notification-targets-scoped.spec.ts
 * in @camstack/types holds those guarantees).
 */
import type { TargetKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeNcTargetHandlers, ncTargetActions } from '../nc-target-actions.js'

const NTFY: TargetKind = {
  kind: 'ntfy',
  label: 'ntfy',
  icon: 'ntfy',
  addonId: 'notifiers',
  supportsDiscovery: false,
  configSchema: { sections: [] },
  caps: {
    attachments: { mediaTypes: [], mode: 'url', max: 0 },
    actions: 0,
    actionIcons: false,
    levels: [],
    format: ['text'],
    clickUrl: false,
    sound: false,
    ttl: false,
    bodyMaxLen: 4096,
  },
}

describe('nc-target-actions', () => {
  it('declares only the kind catalogue: targets are instances', () => {
    expect(Object.keys(ncTargetActions)).toEqual(['nc.listTargetKinds'])
  })

  it('lists the kind catalogue', async () => {
    const nc = makeNcTargetHandlers({ provider: { listTargetKinds: async () => [NTFY] } })
    await expect(nc['nc.listTargetKinds']({})).resolves.toEqual({ kinds: [NTFY] })
  })
})
