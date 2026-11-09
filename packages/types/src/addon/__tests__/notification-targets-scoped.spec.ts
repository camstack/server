/**
 * The authorisation of a notification target at the instance door (epic #440): a user sees and
 * changes only the targets whose `ownerUserId` is theirs, an admin (and an in-process caller with no
 * session) keeps the admin door. These are the guarantees `nc.*MyTarget*` gave, now on
 * `integration-instances`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { CapCaller } from '../../capabilities/capability-definition.js'
import type { IIntegrationInstancesProvider } from '../../capabilities/integration-instances.cap.js'
import type { IScopedLogger } from '../../interfaces/logging.js'
import type { TargetKind } from '../../capabilities/notification-output.cap.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import {
  buildNotificationTargetInstances,
  buildUserScopedNotificationTargetInstances,
  notificationTargetKinds,
} from '../notification-targets.js'

const OWNER = 'notifiers'
const ADMIN: CapCaller = { userId: 'root', isAdmin: true }
const U1: CapCaller = { userId: 'u1', isAdmin: false }
const U2: CapCaller = { userId: 'u2', isAdmin: false }

const NTFY: TargetKind = {
  kind: 'ntfy',
  label: 'ntfy',
  icon: 'ntfy',
  addonId: OWNER,
  supportsDiscovery: false,
  configSchema: {
    sections: [
      {
        id: 'ntfy',
        title: 'ntfy',
        fields: [
          { type: 'text', key: 'topic', label: 'Topic' },
          { type: 'password', key: 'token', label: 'Token' },
        ],
      },
    ],
  },
  caps: {
    attachments: { mediaTypes: [], mode: 'url', max: 0 },
    actions: 0,
    actionIcons: false,
    levels: [],
    format: ['text'],
    clickUrl: false,
    sound: false,
    ttl: false,
    bodyMaxLen: 4096,
  },
}

let seq = 0
let tested: string[] = []
let audit: Array<{ message: string; meta: unknown }> = []

function recordingLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message, extras) => {
      audit.push({ message, meta: extras?.meta })
    },
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

async function world(): Promise<IIntegrationInstancesProvider> {
  const memory = makeInMemoryRecords(OWNER)
  const kinds = notificationTargetKinds([NTFY])
  await memory.records.declare(kinds)
  return buildUserScopedNotificationTargetInstances(
    memory.records,
    {
      descriptors: [NTFY],
      kinds,
      mintId: () => `minted-${++seq}`,
      canProbe: () => true,
      probe: async (input) => {
        tested.push(input.targetId ?? 'draft')
        return { ok: true, resolvedUrl: 'x' }
      },
    },
    recordingLogger(),
  )
}

describe('notification targets at the instance door', () => {
  let door: IIntegrationInstancesProvider
  beforeEach(async () => {
    seq = 0
    tested = []
    audit = []
    door = await world()
    // Pre-existing records keep their ids: an admin seeds one global and one per user.
    await door.createInstance({
      id: 'global-1',
      name: 'House',
      kind: 'ntfy',
      values: { topic: 'g' },
    })
    await door.createInstance({
      id: 'a1',
      name: 'Alice',
      kind: 'ntfy',
      values: { topic: 'a', ownerUserId: 'u1', token: 'secret-a' },
    })
    await door.createInstance({
      id: 'b1',
      name: 'Bob',
      kind: 'ntfy',
      values: { topic: 'b', ownerUserId: 'u2' },
    })
  })

  it('declares itself user-scoped, and a plain provider does not', async () => {
    expect((await door.describe()).userScoped).toBe(true)
    const memory = makeInMemoryRecords(OWNER)
    const kinds = notificationTargetKinds([NTFY])
    await memory.records.declare(kinds)
    const plain = buildNotificationTargetInstances(memory.records, {
      descriptors: [NTFY],
      kinds,
      mintId: () => 'x',
      canProbe: () => false,
    })
    expect((await plain.describe()).userScoped).toBeUndefined()
  })

  it('lists: a user sees only their own, an admin and a session-less caller see all', async () => {
    const ids = async (caller?: CapCaller): Promise<string[]> =>
      (await door.listInstances(caller === undefined ? {} : { caller })).map((i) => i.id).sort()
    expect(await ids(U1)).toEqual(['a1'])
    expect(await ids(U2)).toEqual(['b1'])
    expect(await ids(ADMIN)).toEqual(['a1', 'b1', 'global-1'])
    expect(await ids()).toEqual(['a1', 'b1', 'global-1'])
  })

  it('lists: an admin asking for `mine` gets only their own, never the global or foreign rows', async () => {
    await door.createInstance({
      name: 'Root phone',
      kind: 'ntfy',
      values: { topic: 'r' },
      caller: ADMIN,
    })
    const mine = await door.listInstances({ mine: true, caller: ADMIN })
    expect(mine.map((i) => i.name)).toEqual([])
    const stamped = await door.listInstances({ mine: true, caller: U1 })
    expect(stamped.map((i) => i.id)).toEqual(['a1'])
  })

  it('get: a foreign or ownerless target reads as absent to a user', async () => {
    expect((await door.getInstance({ id: 'a1', caller: U1 }))?.id).toBe('a1')
    expect(await door.getInstance({ id: 'b1', caller: U1 })).toBeNull()
    expect(await door.getInstance({ id: 'global-1', caller: U1 })).toBeNull()
    expect((await door.getInstance({ id: 'b1', caller: ADMIN }))?.id).toBe('b1')
  })

  it('create: the owner is stamped from the caller whatever the client sent, and the id is minted', async () => {
    const created = await door.createInstance({
      id: 'steal-b1',
      name: 'Mine',
      kind: 'ntfy',
      values: { topic: 't', ownerUserId: 'u2' },
      caller: U1,
    })
    expect(created.id).toBe('minted-1')
    const row = await door.getInstance({ id: created.id, caller: ADMIN })
    expect(row?.formValues.ownerUserId).toBe('u1')
    expect(await door.getInstance({ id: 'steal-b1', caller: ADMIN })).toBeNull()
  })

  it('update: only an own target, and the owner cannot move', async () => {
    await expect(
      door.updateInstance({ id: 'b1', values: { topic: 'x' }, caller: U1 }),
    ).rejects.toThrow('forbidden')
    await expect(
      door.updateInstance({ id: 'global-1', values: { topic: 'x' }, caller: U1 }),
    ).rejects.toThrow('forbidden')
    await door.updateInstance({ id: 'a1', values: { topic: 'a2', ownerUserId: 'u2' }, caller: U1 })
    const row = await door.getInstance({ id: 'a1', caller: ADMIN })
    expect(row?.formValues).toMatchObject({ topic: 'a2', ownerUserId: 'u1' })
  })

  it('switch and delete: only an own target', async () => {
    await expect(door.setInstanceEnabled({ id: 'b1', enabled: false, caller: U1 })).rejects.toThrow(
      'forbidden',
    )
    await expect(door.deleteInstance({ id: 'b1', caller: U1 })).rejects.toThrow('forbidden')
    await door.setInstanceEnabled({ id: 'a1', enabled: false, caller: U1 })
    expect((await door.getInstance({ id: 'a1', caller: U1 }))?.enabled).toBe(false)
    await door.deleteInstance({ id: 'a1', caller: U1 })
    expect(await door.getInstance({ id: 'a1', caller: ADMIN })).toBeNull()
    expect(await door.getInstance({ id: 'b1', caller: ADMIN })).not.toBeNull()
  })

  it('audit: every write a user makes names the target and its owner; a refused one writes nothing', async () => {
    audit = []
    const created = await door.createInstance({
      name: 'Phone',
      kind: 'ntfy',
      values: { topic: 'p' },
      caller: U1,
    })
    await door.updateInstance({ id: created.id, values: { topic: 'p2' }, caller: U1 })
    await door.setInstanceEnabled({ id: created.id, enabled: false, caller: U1 })
    await door.deleteInstance({ id: created.id, caller: U1 })
    await door.deleteInstance({ id: 'b1', caller: U1 }).catch(() => undefined)
    expect(audit).toEqual([
      { message: 'notification target created', meta: { targetId: created.id, owner: 'u1' } },
      { message: 'notification target updated', meta: { targetId: created.id, owner: 'u1' } },
      {
        message: 'notification target switched',
        meta: { targetId: created.id, owner: 'u1', enabled: false },
      },
      { message: 'notification target deleted', meta: { targetId: created.id, owner: 'u1' } },
    ])
  })

  it('test: a stored own target only; a foreign one and an unsaved form are refused for a user', async () => {
    await expect(door.testInstance?.({ id: 'b1', values: {}, caller: U1 })).rejects.toThrow(
      'forbidden',
    )
    await expect(
      door.testInstance?.({ id: null, values: { topic: 'z' }, kind: 'ntfy', caller: U1 }),
    ).rejects.toThrow('forbidden')
    expect(tested).toEqual([])
    expect(await door.testInstance?.({ id: 'a1', values: {}, caller: U1 })).toMatchObject({
      success: true,
    })
    expect(tested).toEqual(['a1'])
    // The admin door still probes a draft.
    expect(
      await door.testInstance?.({ id: null, values: { topic: 'z' }, kind: 'ntfy', caller: ADMIN }),
    ).toMatchObject({ success: true })
  })

  it('a user never reads a secret back as text', async () => {
    const row = await door.getInstance({ id: 'a1', caller: U1 })
    expect(JSON.stringify(row?.formValues)).not.toContain('secret-a')
  })
})
