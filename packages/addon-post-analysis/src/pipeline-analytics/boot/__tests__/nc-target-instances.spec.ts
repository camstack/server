/**
 * The dispatcher's targets are the instances of `notification-output`. A Telegram target with a token
 * that is SWITCHED OFF still resolves by the id a rule names (the dispatcher decides what to do with a
 * disabled target), carries its kind's budgets, and a provider that cannot be read is named, never an
 * empty list (D315, D49): the readable targets are still delivered, and a target of the unreadable
 * holder is retried as transient.
 */
import {
  buildNotificationTargetInstances,
  type InstanceApi,
  instanceSourceOverApi,
  makeInMemoryRecords,
  NotificationTargetStore,
  notificationTargetKinds,
  type TargetKind,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NcDispatcher } from '../../../notification-center/dispatcher.js'
import type { NcOutboxEntry } from '../../../notification-center/outbox.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { readNcTargets } from '../nc-target-instances.js'

const TELEGRAM: TargetKind = {
  kind: 'telegram',
  label: 'Telegram',
  icon: 'send',
  addonId: 'notifiers',
  supportsDiscovery: false,
  configSchema: {
    sections: [
      {
        id: 'tg',
        title: 'Telegram',
        fields: [
          { type: 'password', key: 'botToken', label: 'Token' },
          { type: 'text', key: 'chatId', label: 'Chat' },
        ],
      },
    ],
  },
  caps: {
    attachments: { mediaTypes: [], mode: 'url', max: 0 },
    actions: 3,
    actionIcons: false,
    levels: [],
    format: ['text'],
    clickUrl: false,
    sound: false,
    ttl: false,
    bodyMaxLen: 4096,
  },
}

/** The cluster as the hub answers: `notifiers` serves a Telegram target; `import-alexa` can be down. */
async function api(alexaDown = false) {
  const memory = makeInMemoryRecords('notifiers')
  const kinds = notificationTargetKinds([TELEGRAM])
  await memory.records.declare(kinds)
  const store = NotificationTargetStore.of(memory.records, 'notifiers', kinds, [TELEGRAM])
  await store.upsert({
    id: 'tg-1',
    name: 'Phone',
    kind: 'telegram',
    addonId: 'notifiers',
    enabled: false,
    config: { botToken: 'tok', chatId: '42', ownerUserId: 'u-7' },
  })
  const provider = buildNotificationTargetInstances(memory.records, {
    descriptors: [TELEGRAM],
    kinds,
    mintId: () => 'minted',
    canProbe: () => false,
  })
  const holders = alexaDown ? ['notifiers', 'import-alexa'] : ['notifiers']
  const fake: InstanceApi = {
    capabilities: {
      getCapability: {
        query: async ({ name }) => ({
          providers:
            name === 'integration-instances' || name === 'notification-output' ? holders : [],
        }),
      },
    },
    integrationInstances: {
      describe: {
        query: async ({ addonId }) =>
          addonId === 'import-alexa'
            ? Promise.reject(new Error('holder down'))
            : provider.describe(),
      },
      listInstances: { query: async () => provider.listInstances() },
    },
  }
  return fake
}

function entry(targetId: string): NcOutboxEntry {
  return {
    id: `rule-1:trk-1:${targetId}`,
    ruleId: 'rule-1',
    targetId,
    deviceId: 102,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Parking',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 102,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'vehicle',
        zones: [],
        timestamp: 1_753_000_000_000,
      },
    },
  }
}

describe('readNcTargets', () => {
  it('resolves a switched-off Telegram target by its id, with the budgets of its kind and its owner', async () => {
    const read = await readNcTargets(instanceSourceOverApi(await api()), [TELEGRAM])
    expect(read.unreadable).toEqual([])
    expect(read.targets).toEqual([
      {
        id: 'tg-1',
        addonId: 'notifiers',
        name: 'Phone',
        kind: 'telegram',
        enabled: false,
        ownerUserId: 'u-7',
        bodyMaxLen: 4096,
        maxActions: 3,
      },
    ])
  })

  it('names the holder that cannot be read and still returns the readable targets', async () => {
    const read = await readNcTargets(instanceSourceOverApi(await api(true)), [TELEGRAM])
    expect(read.targets.map((t) => t.id)).toEqual(['tg-1'])
    expect(read.unreadable).toEqual([{ addonId: 'import-alexa', error: 'holder down' }])
  })

  it('reports a notification provider that serves no integration-instances as unreadable, never drops it', async () => {
    const fake = await api()
    const older: InstanceApi = {
      ...fake,
      capabilities: {
        getCapability: {
          query: async ({ name }) => ({
            providers:
              name === 'notification-output'
                ? ['notifiers', 'import-alexa']
                : name === 'integration-instances'
                  ? ['notifiers']
                  : [],
          }),
        },
      },
      integrationInstances: {
        describe: {
          query: (input) =>
            input.addonId === 'import-alexa'
              ? Promise.reject(new Error('no integration-instances provider'))
              : fake.integrationInstances.describe.query(input),
        },
        listInstances: fake.integrationInstances.listInstances,
      },
    }
    const read = await readNcTargets(instanceSourceOverApi(older), [TELEGRAM])
    expect(read.targets.map((t) => t.id)).toEqual(['tg-1'])
    expect(read.unreadable).toEqual([
      { addonId: 'import-alexa', error: 'no integration-instances provider' },
    ])
  })

  it('throws only when NOTHING was readable', async () => {
    const api = {
      capabilities: {
        getCapability: {
          query: async () => ({ providers: ['import-alexa'] }),
        },
      },
      integrationInstances: {
        describe: { query: () => Promise.reject(new Error('holder down')) },
        listInstances: { query: async () => [] },
      },
    } satisfies InstanceApi
    await expect(readNcTargets(instanceSourceOverApi(api), [TELEGRAM])).rejects.toThrow(
      /import-alexa \(holder down\)/,
    )
  })

  it('omits the budgets when the kind catalog did not answer', async () => {
    const read = await readNcTargets(instanceSourceOverApi(await api()), [])
    expect(read.targets[0]).not.toHaveProperty('bodyMaxLen')
    expect(read.targets[0]).toMatchObject({ id: 'tg-1', enabled: false })
  })
})

describe('the dispatcher over a catalog with one unreadable holder', () => {
  async function dispatcherOver(alexaDown: boolean) {
    const fake = await api(alexaDown)
    let unreadable: readonly { addonId: string; error: string }[] = []
    const sends: string[] = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => {
        const read = await readNcTargets(instanceSourceOverApi(fake), [TELEGRAM])
        unreadable = read.unreadable
        return read.targets.map((t) => ({ ...t, enabled: true }))
      },
      unreadableTargetHolders: () => unreadable,
      send: async (input) => {
        sends.push(input.targetId)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Parking',
      now: () => 1_753_000_001_000,
      sleep: async () => undefined,
    })
    return { dispatcher, sends }
  }

  it('delivers to the healthy target while the alexa target is retried as transient', async () => {
    const h = await dispatcherOver(true)
    const delivered = await h.dispatcher.deliver(entry('tg-1'))
    expect(delivered.ok).toBe(true)
    expect(h.sends).toEqual(['tg-1'])
    await expect(h.dispatcher.deliver(entry('alexa-echo-1'))).rejects.toThrow(/transient/)
    expect(h.sends).toEqual(['tg-1'])
  })

  it('a target absent from a WHOLE catalog is still a permanent failure', async () => {
    const h = await dispatcherOver(false)
    const result = await h.dispatcher.deliver(entry('alexa-echo-1'))
    expect(result.ok).toBe(false)
  })
})
