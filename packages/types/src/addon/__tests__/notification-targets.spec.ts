/**
 * Notification targets as instances: the per-kind record kinds, the facade the providers keep using, the
 * `integration-instances` provider, and the D987 procedure that flattens the old `config` blob.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '../../interfaces/logging.js'
import { recordSecretRef } from '../../records/secret-paths.js'
import type { TargetKind } from '../../capabilities/notification-output.cap.js'
import { defineRecordKinds } from '../../records/record-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import {
  buildNotificationTargetInstances,
  legacyTargetsOver,
  retiredTargetsOver,
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

function recordingLogger(): {
  readonly logger: IScopedLogger
  readonly warns: string[]
} {
  const warns: string[] = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, context) => {
      warns.push(`${message} ${JSON.stringify(context?.meta ?? {})}`)
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warns }
}

async function world() {
  const memory = makeInMemoryRecords(OWNER)
  const kinds = notificationTargetKinds(DESCRIPTORS)
  await memory.records.declare({ ...kinds, 'notification-targets': LEGACY })
  const { logger, warns } = recordingLogger()
  const oldKind = memory.records.kind(LEGACY)
  const legacy = legacyTargetsOver(oldKind, logger)
  const store = NotificationTargetStore.of(memory.records, OWNER, kinds, DESCRIPTORS, {
    logger,
    legacy,
  })
  const ports = targetRowPortsOver({ legacy, store, logger })
  const secretKeys = (kind: string): readonly string[] =>
    secretKeysOf(DESCRIPTORS.find((d) => d.kind === kind) ?? TELEGRAM)
  return { memory, kinds, store, oldKind, ports, secretKeys, warns }
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

  it('a row whose secret does not read back fails the run, is undone and stays served from the retired kind while the others move', async () => {
    const lying = {
      ...w.ports,
      readNew: async (kind: string, id: string) =>
        id === 'tg-1' ? { name: 'Phone', botToken: 'something-else' } : w.ports.readNew(kind, id),
    }
    // The run rejects, naming the failed id and its reason, so the ledger records `failed` and reruns.
    await expect(moveTargetRows(lying, w.secretKeys)).rejects.toThrow(
      /tg-1 \(botToken did not read back\)/,
    )
    // The good row moved and its retired row is gone.
    expect(await w.oldKind.get('wh-1')).toBeNull()
    expect(await w.memory.records.kind(w.kinds['notify-webhook']!).get('wh-1')).not.toBeNull()
    // The bad row: its half-written new record is undone, its retired row is still there.
    expect(await w.memory.records.kind(w.kinds['notify-telegram']!).get('tg-1')).toBeNull()
    expect(await w.oldKind.get('tg-1')).not.toBeNull()
    // The store still serves it, from the retired kind, with its switch as it was.
    expect(await w.store.getById('tg-1')).toMatchObject({
      id: 'tg-1',
      kind: 'telegram',
      enabled: false,
    })
    expect((await w.store.list()).map((t) => t.id).sort()).toEqual(['tg-1', 'wh-1'])
    // The skip is on the record, with the id and the reason.
    expect(w.warns.some((line) => line.includes('tg-1') && line.includes('botToken'))).toBe(true)
  })

  it('a row whose write throws fails the run naming it, the others still move and it stays served', async () => {
    const failing = {
      ...w.ports,
      writeNew: async (kind: string, id: string, body: Parameters<typeof w.ports.writeNew>[2]) => {
        if (id === 'wh-1') throw new Error('keychain locked')
        await w.ports.writeNew(kind, id, body)
      },
    }
    await expect(moveTargetRows(failing, w.secretKeys)).rejects.toThrow(/wh-1 \(keychain locked\)/)
    // The other row moved.
    expect(await w.oldKind.get('tg-1')).toBeNull()
    expect(await w.memory.records.kind(w.kinds['notify-telegram']!).get('tg-1')).not.toBeNull()
    // The failed row: nothing in the new kind, retired row kept, still served.
    expect(await w.memory.records.kind(w.kinds['notify-webhook']!).get('wh-1')).toBeNull()
    expect(await w.oldKind.get('wh-1')).not.toBeNull()
    expect(await w.store.getById('wh-1')).toMatchObject({
      id: 'wh-1',
      kind: 'webhook',
      enabled: true,
    })
    expect(w.warns.some((line) => line.includes('wh-1') && line.includes('keychain locked'))).toBe(
      true,
    )
  })

  it('rows left in the retired kind stay served by the store: listed, readable, and a switch moves the row', async () => {
    const lying = { ...w.ports, readNew: async () => null }
    await expect(moveTargetRows(lying, w.secretKeys)).rejects.toThrow(/tg-1 .*wh-1 /)
    // Nothing moved, and every half-written new record was undone.
    expect(await w.oldKind.get('tg-1')).not.toBeNull()
    expect(await w.oldKind.get('wh-1')).not.toBeNull()
    expect(await w.memory.records.kind(w.kinds['notify-telegram']!).get('tg-1')).toBeNull()
    expect(await w.memory.records.kind(w.kinds['notify-webhook']!).get('wh-1')).toBeNull()
    // Served: both rows are listed and readable (the unserved kind is not ours to show).
    expect((await w.store.list()).map((t) => t.id).sort()).toEqual(['tg-1', 'wh-1'])
    expect(await w.store.getById('tg-1')).toMatchObject({
      id: 'tg-1',
      enabled: false,
    })
    // Flipping the switch moves the row to its record and drops the retired one.
    expect(await w.store.setEnabled('tg-1', true)).toMatchObject({
      id: 'tg-1',
      enabled: true,
    })
    expect(await w.oldKind.get('tg-1')).toBeNull()
    expect(await w.memory.records.kind(w.kinds['notify-telegram']!).get('tg-1')).not.toBeNull()
  })

  it('the retired kind is declared on the first list of the store, not before', async () => {
    const memory = makeInMemoryRecords(OWNER)
    await memory.records.declare(notificationTargetKinds(DESCRIPTORS))
    const declare = vi.spyOn(memory.records, 'declare')
    const lazy = retiredTargetsOver(memory.records, LEGACY, recordingLogger().logger)
    expect(declare).not.toHaveBeenCalled()
    expect(await lazy.list()).toEqual([])
    expect(declare).toHaveBeenCalledTimes(1)
    memory.seed('notification-targets', {
      id: 'x',
      data: {
        name: 'n',
        kind: 'webhook',
        addonId: OWNER,
        enabled: true,
        config: {},
      },
    })
    expect((await lazy.list()).map((row) => row.id)).toEqual(['x'])
  })

  it('a record that is no valid target is named in the log, not dropped silently', async () => {
    w.memory.seed('notify-telegram', { id: 'bad-1', data: { name: 5 } })
    expect((await w.store.list()).map((t) => t.id)).not.toContain('bad-1')
    expect(w.warns.some((line) => line.includes('bad-1') && line.includes('telegram'))).toBe(true)
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

  it('a kind carries the icon its descriptor declares, and none when it declares none', async () => {
    const provider = buildNotificationTargetInstances(w.memory.records, {
      descriptors: [
        { ...TELEGRAM, iconUrl: '/addon/notifiers/icons/telegram', iconMediaType: 'image/svg+xml' },
        WEBHOOK,
      ],
      kinds: w.kinds,
      mintId: () => 'minted',
      canProbe: () => false,
    })
    const description = await provider.describe()
    expect(description.kinds?.map((k) => [k.id, k.iconUrl, k.iconMediaType])).toEqual([
      ['telegram', '/addon/notifiers/icons/telegram', 'image/svg+xml'],
      ['webhook', undefined, undefined],
    ])
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
