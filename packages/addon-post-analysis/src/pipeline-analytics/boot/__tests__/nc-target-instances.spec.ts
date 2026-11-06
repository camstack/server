/**
 * The dispatcher's targets are the instances of `notification-output`. A Telegram target with a token
 * that is SWITCHED OFF still resolves by the id a rule names (the dispatcher decides what to do with a
 * disabled target), carries its kind's budgets, and a provider that cannot be read is an error, never
 * an empty list (D315, D49).
 */
import {
  buildNotificationTargetInstances,
  makeInMemoryRecords,
  NotificationTargetStore,
  notificationTargetKinds,
  type TargetKind,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { instanceSourceOverApi, type NcInstanceApi, readNcTargets } from '../nc-target-instances.js'

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

async function api(broken = false) {
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
  const fake: NcInstanceApi = {
    capabilities: {
      getCapability: {
        query: async ({ name }) => ({
          providers:
            name === 'integration-instances' || name === 'notification-output' ? ['notifiers'] : [],
        }),
      },
    },
    integrationInstances: {
      describe: {
        query: async () =>
          broken ? Promise.reject(new Error('holder down')) : provider.describe(),
      },
      listInstances: { query: async () => provider.listInstances() },
    },
  }
  return fake
}

describe('readNcTargets', () => {
  it('resolves a switched-off Telegram target by its id, with the budgets of its kind and its owner', async () => {
    const targets = await readNcTargets(instanceSourceOverApi(await api()), [TELEGRAM])
    expect(targets).toEqual([
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

  it('throws when a provider cannot be read instead of answering with no targets', async () => {
    await expect(readNcTargets(instanceSourceOverApi(await api(true)), [TELEGRAM])).rejects.toThrow(
      /notifiers \(holder down\)/,
    )
  })

  it('omits the budgets when the kind catalog did not answer', async () => {
    const targets = await readNcTargets(instanceSourceOverApi(await api()), [])
    expect(targets[0]).not.toHaveProperty('bodyMaxLen')
    expect(targets[0]).toMatchObject({ id: 'tg-1', enabled: false })
  })
})
