/**
 * D444 — a child's custom-action catalogs ride its register frame, schemas
 * stripped, exactly like `eventPatterns`: the parent learns them race-free at
 * the post-init re-register, from the process that owns the addon. The hub
 * used to learn them by evaluating the addon's bundle inside hub-main.
 *
 * Disarm: drop `customActions` from `registerFrame()` in
 * `local-child-client.ts` — the first test sees `undefined` on the parent's
 * `RegisteredChild` after `updateCaps(caps, catalogs)`.
 */
import type { ChildCustomActionCatalogs } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'

const nid = () => `hub-test-${process.pid}-${Math.random().toString(36).slice(2)}`

const catalogs: ChildCustomActionCatalogs = {
  benchmark: { run: { kind: 'mutation', auth: 'admin', scope: { kind: 'system' } } },
  'model-studio': {},
}

describe('LocalChildClient — custom-action catalogs in the register frame', () => {
  let registry: LocalChildRegistry | null = null
  let child: LocalChildClient | null = null
  afterEach(async () => {
    await child?.close()
    child = null
    await registry?.close()
    registry = null
  })

  it('the pre-init register OMITS the field; updateCaps(caps, catalogs) carries it', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    const registered: Array<ChildCustomActionCatalogs | undefined> = []
    registry.onChildRegistered((c) => {
      registered.push(c.customActions)
    })

    const caps = [
      { capName: 'addon-pages-source', mode: 'collection', addonId: 'benchmark' },
    ] as const
    child = new LocalChildClient({
      nodeId,
      childId: 'ml',
      caps: [...caps],
      dispatch: async () => 'ok',
    })
    await child.start()
    expect(registered).toEqual([undefined])

    await child.updateCaps([...caps], catalogs)
    expect(registered[1]).toEqual(catalogs)
  })

  it('a later re-register WITHOUT catalogs re-carries the remembered ones (native-cap change, reconnect)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    const registered: Array<ChildCustomActionCatalogs | undefined> = []
    registry.onChildRegistered((c) => {
      registered.push(c.customActions)
    })

    child = new LocalChildClient({ nodeId, childId: 'ml', caps: [], dispatch: async () => 'ok' })
    await child.start()
    await child.updateCaps([], catalogs)
    await child.updateCaps([{ capName: 'ptz', mode: 'collection', deviceId: 7 }])
    expect(registered.at(-1)).toEqual(catalogs)
  })
})
