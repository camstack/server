/**
 * What "Add device" inside a Reolink integration offers, decided per instance by the same rule
 * `integrationIsHub` uses: an NVR / Home Hub integration (host, a hub candidate origin, or the
 * migrated-from-Hub marker) adopts its children; the default integration scans.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { MIGRATED_FROM_HUB_KEY } from '../hub-connection.js'
import {
  buildReolinkInstances,
  type ReolinkRegistryEvidence,
  reolinkInstancesProvider,
  reolinkRecordKinds,
} from '../reolink-instances.js'

async function served(
  rows: readonly { id: string; host?: string; evidence: ReolinkRegistryEvidence | null }[],
) {
  const world = makeInMemoryRecords('provider-reolink')
  await world.records.declare(reolinkRecordKinds)
  const evidence = new Map(rows.map((r) => [r.id, r.evidence]))
  const deps = {
    onChanged: async () => {},
    registryEvidenceOf: async (id: string) => evidence.get(id) ?? null,
    makeHubProbe: () => {
      throw new Error('unused')
    },
  }
  const provider = reolinkInstancesProvider(buildReolinkInstances(world.records, deps), deps)
  for (const r of rows) {
    await provider.createInstance({
      id: r.id,
      name: r.id,
      ...(r.host !== undefined ? { values: { host: r.host } } : {}),
    })
  }
  const byId = new Map((await provider.listInstances({})).map((i) => [i.id, i.addDevice]))
  return { byId, provider }
}

describe('reolink instances state what Add device offers', () => {
  it('the default integration scans, an integration with a host adopts its children', async () => {
    const { byId } = await served([
      { id: 'default', evidence: { info: {} } },
      { id: 'nvr', host: '192.0.2.10', evidence: { info: {} } },
    ])
    expect(byId.get('default')).toBe('scan')
    expect(byId.get('nvr')).toBe('children')
  })

  it('a hub integration adopted from a hub candidate (empty host) adopts its children', async () => {
    const { byId } = await served([
      { id: 'hub', evidence: { originStableId: 'reolink-hub-0001', info: {} } },
    ])
    expect(byId.get('hub')).toBe('children')
  })

  it('an integration migrated from a Hub device (empty host) adopts its children', async () => {
    const { byId, provider } = await served([
      { id: 'moved', evidence: { info: { [MIGRATED_FROM_HUB_KEY]: 7 } } },
    ])
    expect(byId.get('moved')).toBe('children')
    expect((await provider.getInstance({ id: 'moved' }))?.addDevice).toBe('children')
  })
})
