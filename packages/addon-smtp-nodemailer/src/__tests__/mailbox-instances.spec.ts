import { BrokerInUseError, makeInMemoryRecords } from '@camstack/types'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { buildMailboxInstances } from '../mailbox-instances.js'
import { mailboxesKind } from '../mailbox-record-kinds.js'

async function setup(subscribers: readonly string[] = []) {
  const world = makeInMemoryRecords('smtp-nodemailer')
  await world.records.declare({ mailboxes: mailboxesKind })
  const reconciled: string[] = []
  const provider = buildMailboxInstances(world.records, {
    inbound: {
      reconcileMailbox: async (id) => {
        reconciled.push(id)
      },
      runtimeOf: () => ({ status: 'connected', error: null, checkedAt: 7 }),
      subscriberUsers: () => ({
        find: async () => subscribers.map((id) => ({ kind: 'subscriber', id })),
      }),
    },
  })
  return { provider, reconciled }
}

describe('inbound mailboxes as integration instances', () => {
  it('create mints the credentials, applies the listener and reports its status', async () => {
    const { provider, reconciled } = await setup()
    const { id } = await provider.createInstance({ name: 'Cameras' })
    expect(id).toMatch(/^smtp-inbound-/)
    expect(reconciled).toEqual([id])
    const row = await provider.getInstance({ id })
    expect(row).toMatchObject({ name: 'Cameras', status: { state: 'ok', label: 'Listening' } })
    expect(String(row?.formValues['username'])).toMatch(/^camstack-/)
    expect(row?.formValues['password']).not.toBe('')
  })

  it('refuses removing a mailbox a subscriber still reads, and removes an unused one', async () => {
    const used = await setup(['reolink-1'])
    const { id } = await used.provider.createInstance({ name: 'Used' })
    await expect(used.provider.deleteInstance({ id })).rejects.toBeInstanceOf(BrokerInUseError)
    expect(await used.provider.getInstance({ id })).not.toBeNull()

    const free = await setup()
    const made = await free.provider.createInstance({ name: 'Free' })
    await free.provider.deleteInstance({ id: made.id })
    expect(await free.provider.getInstance({ id: made.id })).toBeNull()
    expect(free.reconciled).toEqual([made.id, made.id])
  })

  it('before the mailbox exists, tests whether the port can be taken', async () => {
    const { provider } = await setup()
    const taken = createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    const address = taken.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    try {
      const busy = await provider.testInstance?.({
        id: null,
        values: { port: address.port, bindHost: '127.0.0.1' },
      })
      expect(busy).toMatchObject({ success: false, status: 'rejected' })
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()))
    }
    const free = await provider.testInstance?.({
      id: null,
      values: { port: address.port, bindHost: '127.0.0.1' },
    })
    expect(free).toMatchObject({ success: true, status: 'validated' })
  })
})
