/** What "Add device" inside a reolink integration offers is the provider's call, per instance. */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildReolinkInstances, reolinkRecordKinds } from '../reolink-instances.js'

const DEPS = {
  onChanged: async () => {},
  registryEvidenceOf: async () => null,
  makeHubProbe: () => {
    throw new Error('unused')
  },
}

describe('reolink instances state what Add device offers', () => {
  it('the default integration (no host) scans, an NVR / Home Hub integration (host set) adopts its children', async () => {
    const world = makeInMemoryRecords('provider-reolink')
    await world.records.declare(reolinkRecordKinds)
    const provider = buildReolinkInstances(world.records, DEPS).toProvider()
    await provider.createInstance({ id: 'default', name: 'Reolink' })
    await provider.createInstance({ id: 'nvr', name: 'NVR', values: { host: '192.0.2.10' } })
    const byId = new Map((await provider.listInstances({})).map((i) => [i.id, i.addDevice]))
    expect(byId.get('default')).toBe('scan')
    expect(byId.get('nvr')).toBe('children')
  })
})
