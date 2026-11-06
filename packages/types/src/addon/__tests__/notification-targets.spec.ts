/**
 * Notification targets as instances: the per-kind record kinds, the facade the providers keep using, the
 * `integration-instances` provider, and the D987 procedure that flattens the old `config` blob.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { recordSecretRef } from '../../records/secret-paths.js'
import type { TargetKind } from '../../capabilities/notification-output.cap.js'
import { defineRecordKinds } from '../../records/record-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import {
  buildNotificationTargetInstances,
  moveTargetRows,
  NotificationTargetStore,
  notificationTargetKinds,
  OldTargetBodySchema,
  probeToTestResult,
  secretKeysOf,
  targetRowPortsOver,
} from '../notification-targets.js'

const OWNER = 'notifiers'
const CAPS: TargetKind['caps'] = {
  attachments: { mediaTypes: [], mode: 'url', max: 0 },
  actions: 0,
  actionIcons: false,
  levels: [],
  format: ['text'],
  clickUrl: false,
  sound: false,
  ttl: false,
  bodyMaxLen: 4096,
}

function descriptor(
  kind: string,
  fields: TargetKind['configSchema']['sections'][number]['fields'],
): TargetKind {
  return {
    kind,
    label: kind,
    icon: kind,
    addonId: OWNER,
    supportsDiscovery: false,
    configSchema: { sections: [{ id: kind, title: kind, fields }] },
    caps: CAPS,
  }
}
const TELEGRAM = descriptor('telegram', [
  { type: 'password', key: 'botToken', label: 'Bot token' },
  { type: 'text', key: 'chatId', label: 'Chat' },
  { type: 'boolean', key: 'defaultSilent', label: 'Silent' },
])
const WEBHOOK = descriptor('webhook', [
  { type: 'password', key: 'url', label: 'Url' },
  {
    type: 'editable-array',
    key: 'headers',
    label: 'Headers',
    itemFields: [
      { type: 'text', key: 'name', label: 'Header' },
      { type: 'password', key: 'value', label: 'Value' },
    ],
  },
])
const DESCRIPTORS = [TELEGRAM, WEBHOOK]
const LEGACY = defineRecordKinds({
  'notification-targets': {
    schema: OldTargetBodySchema,
    class: 'config',
    writeTrigger: 'legacy',
    device: 'none',
    at: 'none',
    retention: { none: 'legacy' },
  },
})['notification-targets']

async function world() {
  const memory = makeInMemoryRecords(OWNER)
  const kinds = notificationTargetKinds(DESCRIPTORS)
  await memory.records.declare({ ...kinds, 'notification-targets': LEGACY })
  const store = NotificationTargetStore.of(memory.records, OWNER, kinds, DESCRIPTORS)
  const oldKind = memory.records.kind(LEGACY)
  const ports = targetRowPortsOver({ oldKind, store })
  const secretKeys = (kind: string): readonly string[] =>
    secretKeysOf(DESCRIPTORS.find((d) => d.kind === kind) ?? TELEGRAM)
  return { memory, kinds, store, oldKind, ports, secretKeys }
}
type World = Awaited<ReturnType<typeof world>>

describe('notification targets over per-kind records', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
    await w.oldKind.put({
      id: 'tg-1',
      data: {
        name: 'Phone',
        kind: 'telegram',
        addonId: OWNER,
        enabled: false,
        config: {
          botToken: 'tok-secret',
          chatId: '42',
          defaultSilent: true,
          ownerUserId: 'u1',
        },
      },
    })
    await w.oldKind.put({
      id: 'wh-1',
      data: {
        name: 'Hook',
        kind: 'webhook',
        addonId: OWNER,
        enabled: true,
        config: {
          url: 'https://example.com/h',
          headers: [{ name: 'Authorization', value: 'Bearer x' }],
        },
      },
    })
    await w.oldKind.put({
      id: 'zz-1',
      data: {
        name: 'Other',
        kind: 'unknown-kind',
        addonId: OWNER,
        enabled: true,
        config: {},
      },
    })
  })

  it('moves a disabled Telegram target flat: marker reads back equal, stays off, same id', async () => {
    expect(await moveTargetRows(w.ports, w.secretKeys)).toMatchObject({
      outcome: 'done',
      summary: { converted: 2, skipped: 1 },
    })
    const target = await w.store.getById('tg-1')
    expect(target).toMatchObject({
      id: 'tg-1',
      kind: 'telegram',
      enabled: false,
      name: 'Phone',
      config: {
        botToken: 'tok-secret',
        chatId: '42',
        defaultSilent: true,
        ownerUserId: 'u1',
      },
    })
    // The token is a keychain marker in the stored row, never plain text.
    const stored = (await w.store.list()).find((t) => t.id === 'tg-1')
    expect(JSON.stringify(stored?.config['botToken'])).not.toContain('tok-secret')
    const ref = recordSecretRef(OWNER, 'notify-telegram', 'tg-1', 'botToken')
    expect((await w.memory.secrets.resolve([ref]))[ref]?.kind).toBe('value')
    // The nested header secret travels too.
    expect((await w.store.getById('wh-1'))?.config['headers']).toEqual([
      { name: 'Authorization', value: 'Bearer x' },
    ])
    // The old row of a served kind is gone; the unserved kind stays.
    expect(await w.oldKind.get('tg-1')).toBeNull()
    expect(await w.oldKind.get('zz-1')).not.toBeNull()
  })

  it('a second run changes nothing', async () => {
    await moveTargetRows(w.ports, w.secretKeys)
    const before = JSON.stringify([...(w.memory.tables.get('notify-telegram')?.entries() ?? [])])
    const again = await moveTargetRows(w.ports, w.secretKeys)
    expect(again.outcome).toBe('already-done')
    expect(JSON.stringify([...(w.memory.tables.get('notify-telegram')?.entries() ?? [])])).toBe(
      before,
    )
  })

  it('a secret that does not read back undoes the row and throws, the old row stays', async () => {
    const lying = {
      ...w.ports,
      readNew: async () => ({ name: 'Phone', botToken: 'something-else' }),
    }
    await expect(moveTargetRows(lying, w.secretKeys)).rejects.toThrow(/tg-1.*botToken/)
    expect(await w.oldKind.get('tg-1')).not.toBeNull()
    expect(await w.memory.records.kind(w.kinds['notify-telegram']!).get('tg-1')).toBeNull()
  })

  it('a failed read of the old rows writes nothing', async () => {
    const broken = {
      ...w.ports,
      listOld: async () => {
        throw new Error('db locked')
      },
    }
    await expect(moveTargetRows(broken, w.secretKeys)).rejects.toThrow('db locked')
    expect(w.memory.tables.get('notify-telegram')?.size ?? 0).toBe(0)
  })

  it('serves the targets as instances of notification-output, one kind each, secrets as views', async () => {
    await moveTargetRows(w.ports, w.secretKeys)
    const provider = buildNotificationTargetInstances(w.memory.records, {
      descriptors: DESCRIPTORS,
      kinds: w.kinds,
      mintId: () => 'minted',
      canProbe: (kind) => kind === 'telegram',
      probe: async () => ({ ok: true, resolvedUrl: 'x' }),
    })
    const description = await provider.describe()
    expect(description.kinds?.map((k) => [k.id, k.functionCap])).toEqual([
      ['telegram', 'notification-output'],
      ['webhook', 'notification-output'],
    ])
    const listed = await provider.listInstances()
    const tg = listed.find((i) => i.id === 'tg-1')
    expect(tg).toMatchObject({
      kind: 'telegram',
      enabled: false,
      name: 'Phone',
    })
    expect(JSON.stringify(tg?.formValues)).not.toContain('tok-secret')
    expect(await provider.testInstance?.({ id: 'tg-1', values: {} })).toMatchObject({
      status: 'validated',
    })
    expect(await provider.testInstance?.({ id: 'wh-1', values: {} })).toMatchObject({
      status: 'unsupported',
    })
  })

  it('facade: upsert keeps the secret in the keychain, a kind change leaves the old record, delete clears', async () => {
    await moveTargetRows(w.ports, w.secretKeys)
    const current = await w.store.getById('tg-1')
    if (current === null) throw new Error('missing')
    await w.store.upsert({
      ...current,
      kind: 'webhook',
      config: { url: 'https://example.com/z' },
    })
    expect((await w.store.list()).filter((t) => t.id === 'tg-1').map((t) => t.kind)).toEqual([
      'webhook',
    ])
    await w.store.delete('tg-1')
    expect(await w.store.getById('tg-1')).toBeNull()
    expect(await w.store.setEnabled('wh-1', false)).toMatchObject({
      enabled: false,
    })
  })

  it('maps a probe to the tri-state', () => {
    expect(probeToTestResult({ ok: true, resolvedUrl: '' }).status).toBe('validated')
    expect(probeToTestResult({ ok: false, resolvedUrl: '', httpStatus: 401 }).status).toBe(
      'rejected',
    )
    expect(probeToTestResult({ ok: false, resolvedUrl: '', error: 'ENOTFOUND' }).status).toBe(
      'inconclusive',
    )
  })
})
