/**
 * The camera mailbox is a LINK of the Reolink integration (D1013 rule 5): declared where the hub
 * reads it, visible in `describe().links`, and a mailbox an integration uses cannot be deleted.
 */
import {
  assertInstanceUnused,
  fieldUserFinder,
  InstanceInUseError,
  makeInMemoryRecords,
  SMTP_INBOUND_KIND,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { mailboxLinkStoreOver } from '../mailbox-link-store.js'
import { buildReolinkInstances, reolinkRecordKinds } from '../reolink-instances.js'

async function world() {
  const mem = makeInMemoryRecords('provider-reolink')
  await mem.records.declare(reolinkRecordKinds)
  const instances = buildReolinkInstances(mem.records, {
    onChanged: async () => undefined,
    registryEvidenceOf: async () => null,
  })
  await instances.createInstance({ id: 'int-default', name: 'Reolink' })
  await instances.createInstance({ id: 'int-nvr', name: 'NVR' })
  return { instances, store: mailboxLinkStoreOver(mem.records) }
}

describe('the Reolink mailbox link', () => {
  it('is declared in describe().links, to an smtp-inbound broker', async () => {
    const { instances } = await world()
    const links = (await instances.describe()).links ?? []
    expect(links).toEqual([
      {
        kind: 'connections',
        field: 'mailboxId',
        to: { cap: 'broker', kind: SMTP_INBOUND_KIND },
      },
    ])
  })

  it('the store reads an unlinked integration as empty and writes the link and its release', async () => {
    const { instances, store } = await world()
    expect(await store.list()).toEqual(
      expect.arrayContaining([
        { id: 'int-default', mailboxId: '' },
        { id: 'int-nvr', mailboxId: '' },
      ]),
    )
    await store.set('int-default', 'smtp-inbound-1')
    expect((await instances.getResolved('int-default'))?.mailboxId).toBe('smtp-inbound-1')
    await store.set('int-default', '')
    expect((await instances.getResolved('int-default'))?.mailboxId).toBeUndefined()
  })

  it('an integration that uses the mailbox makes deleting it refused, naming the integration', async () => {
    const { instances, store } = await world()
    await store.set('int-default', 'smtp-inbound-1')
    // The finders the hub builds from the DECLARED links (`InstanceLinksIndex.findersFor`).
    const finders = ((await instances.describe()).links ?? []).map((link) =>
      fieldUserFinder({
        kind: link.kind,
        field: link.field,
        list: () => instances.listInstances(),
      }),
    )
    expect(finders).toHaveLength(1)
    const refusal = await assertInstanceUnused('smtp-inbound-1', finders).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(InstanceInUseError)
    expect(JSON.stringify(refusal)).toContain('int-default')
    await store.set('int-default', '')
    await expect(assertInstanceUnused('smtp-inbound-1', finders)).resolves.toBeUndefined()
  })
})
