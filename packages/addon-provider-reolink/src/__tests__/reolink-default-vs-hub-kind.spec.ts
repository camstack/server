/**
 * The default integration (standalone cameras) and an NVR / Home Hub integration are two KINDS of
 * one record: the default holds a name and the camera mailbox link and offers no Test; a hub holds
 * its connection, offers Test and never carries the mailbox link.
 */
import type { ConfigField, ConfigUISchema } from '@camstack/types'
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildReolinkInstances,
  ReolinkEvidenceCache,
  type ReolinkRegistryEvidence,
  reolinkInstancesProvider,
  reolinkRecordKinds,
} from '../reolink-instances.js'

function keysOf(schema: ConfigUISchema): string[] {
  const out: string[] = []
  for (const section of schema.sections) {
    for (const field of section.fields as readonly ConfigField[]) {
      if ('key' in field) out.push(field.key)
    }
  }
  return out
}

const EVIDENCE: ReadonlyMap<string, ReolinkRegistryEvidence> = new Map([
  ['int-default', { originStableId: undefined, info: {} }],
  ['int-hub', { originStableId: 'reolink-hub-uid-1', info: {} }],
  ['int-hub-nohost', { originStableId: 'reolink-hub-uid-2', info: {} }],
])

async function world() {
  const mem = makeInMemoryRecords('provider-reolink')
  await mem.records.declare(reolinkRecordKinds)
  const registryEvidenceOf = async (id: string): Promise<ReolinkRegistryEvidence | null> =>
    EVIDENCE.get(id) ?? null
  const instances = buildReolinkInstances(mem.records, {
    onChanged: async () => undefined,
    registryEvidenceOf,
    makeHubProbe: () => {
      throw new Error('no hub probe in this spec')
    },
  })
  const evidenceCache = new ReolinkEvidenceCache()
  for (const [id, evidence] of EVIDENCE) evidenceCache.set(id, evidence)
  const provider = reolinkInstancesProvider(instances, { registryEvidenceOf, evidenceCache })
  await provider.createInstance({ id: 'int-default', name: 'Reolink' })
  await provider.createInstance({
    id: 'int-hub',
    name: 'NVR',
    values: { host: '10.0.0.5', username: 'admin' },
  })
  // A hub integration whose host is missing, and one the registry has not been asked about yet.
  await provider.createInstance({ id: 'int-hub-nohost', name: 'NVR without host' })
  await provider.createInstance({ id: 'int-unknown', name: 'Unknown' })
  return provider
}

describe('Reolink default integration vs NVR / Home Hub integration', () => {
  it('declares a default kind with no Test and a connection kind with Test', async () => {
    const { kinds } = await (await world()).describe()
    expect(kinds.map((k) => [k.id, k.canTest])).toEqual([
      ['default', false],
      ['connection', true],
    ])
  })

  it('stamps each instance by the registry evidence: a hub with no host stays a connection, an unknown one too', async () => {
    const rows = await (await world()).listInstances({})
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ['int-default', 'default'],
      ['int-hub', 'connection'],
      ['int-hub-nohost', 'connection'],
      ['int-unknown', 'connection'],
    ])
  })

  it('declares the mailbox link on the default kind only', async () => {
    const { links } = await (await world()).describe()
    expect(links?.map((l) => [l.kind, l.field])).toEqual([['default', 'mailboxId']])
  })

  it('the default form is the mailbox picker, the hub form is the connection without it', async () => {
    const provider = await world()
    const def = keysOf(await provider.instanceFormSchema({ id: 'int-default' }))
    const hub = keysOf(await provider.instanceFormSchema({ id: 'int-hub' }))
    expect(def).toEqual(['mailboxId'])
    expect(hub).toContain('host')
    expect(hub).not.toContain('mailboxId')
  })
})
