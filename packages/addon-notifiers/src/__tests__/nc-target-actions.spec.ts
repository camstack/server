/**
 * The `nc.*` actions the SHIPPED Notification Center viewer still calls. They are thin delegates
 * onto the caller-scoped `integration-instances` door (one store, no second one): each test calls
 * an action exactly as the viewer does and reads what the viewer reads.
 */
import {
  buildUserScopedNotificationTargetInstances,
  type CustomActionCaller,
  type IIntegrationInstancesProvider,
  type IScopedLogger,
  makeInMemoryRecords,
  notificationTargetKinds,
  type Target,
  type TargetKind,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeNcTargetHandlers, ncTargetActions } from '../nc-target-actions.js'

const OWNER = 'notifiers'
const U1: CustomActionCaller = { userId: 'u1', isAdmin: false }
const U2: CustomActionCaller = { userId: 'u2', isAdmin: false }
const ADMIN: CustomActionCaller = { userId: 'root', isAdmin: true }

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
        fields: [{ type: 'text', key: 'topic', label: 'Topic' }],
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

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

let seq = 0
let tested: string[] = []

async function door(): Promise<IIntegrationInstancesProvider> {
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
    quiet,
  )
}

const draft = (over: Partial<Target> = {}): Target => ({
  id: '',
  name: 'Mine',
  kind: 'ntfy',
  addonId: OWNER,
  enabled: true,
  config: { topic: 't' },
  ...over,
})

describe('nc-target-actions (the shipped viewer, onto the instance door)', () => {
  let instances: IIntegrationInstancesProvider
  let nc: ReturnType<typeof makeNcTargetHandlers>

  beforeEach(async () => {
    seq = 0
    tested = []
    instances = await door()
    nc = makeNcTargetHandlers({
      provider: { listTargetKinds: async () => [NTFY] },
      instances,
    })
    await instances.createInstance({ id: 'g1', name: 'House', kind: 'ntfy', values: { topic: 'g' } })
    await instances.createInstance({
      id: 'b1',
      name: 'Bob',
      kind: 'ntfy',
      values: { topic: 'b', ownerUserId: 'u2' },
    })
  })

  it('declares the six names the viewer calls', () => {
    expect(Object.keys(ncTargetActions).sort()).toEqual([
      'nc.deleteMyTarget',
      'nc.listMyTargets',
      'nc.listTargetKinds',
      'nc.setMyTargetEnabled',
      'nc.testMyTarget',
      'nc.upsertMyTarget',
    ])
  })

  it('lists the kind catalogue', async () => {
    await expect(nc['nc.listTargetKinds']({})).resolves.toEqual({ kinds: [NTFY] })
  })

  it('upsert creates a target owned by the caller, and list returns only the caller own', async () => {
    const { target } = await nc['nc.upsertMyTarget']({ target: draft() }, U1)
    expect(target).toMatchObject({
      id: 'minted-1',
      name: 'Mine',
      kind: 'ntfy',
      addonId: OWNER,
      enabled: true,
      config: { topic: 't', ownerUserId: 'u1' },
    })
    const { targets } = await nc['nc.listMyTargets']({}, U1)
    expect(targets.map((t) => t.id)).toEqual(['minted-1'])
    expect((await nc['nc.listMyTargets']({}, U2)).targets.map((t) => t.id)).toEqual(['b1'])
  })

  it('a client-sent owner is re-stamped, and an admin own list leaves the global rows out', async () => {
    const { target } = await nc['nc.upsertMyTarget'](
      { target: draft({ config: { topic: 't', ownerUserId: 'u2' } }) },
      ADMIN,
    )
    expect(target.config['ownerUserId']).toBe('root')
    expect((await nc['nc.listMyTargets']({}, ADMIN)).targets.map((t) => t.id)).toEqual([
      target.id,
    ])
  })

  it('upsert edits an own target in place, and a foreign id is minted fresh, never clobbered', async () => {
    const { target } = await nc['nc.upsertMyTarget']({ target: draft() }, U1)
    const edited = await nc['nc.upsertMyTarget'](
      { target: { ...target, name: 'Renamed', config: { topic: 't2' } } },
      U1,
    )
    expect(edited.target).toMatchObject({ id: target.id, name: 'Renamed' })
    expect(edited.target.config).toMatchObject({ topic: 't2', ownerUserId: 'u1' })

    const stolen = await nc['nc.upsertMyTarget']({ target: draft({ id: 'b1' }) }, U1)
    expect(stolen.target.id).not.toBe('b1')
    const bob = await instances.getInstance({ id: 'b1' })
    expect(bob?.formValues).toMatchObject({ topic: 'b', ownerUserId: 'u2' })
  })

  it('upsert keeps a target created off', async () => {
    const { target } = await nc['nc.upsertMyTarget']({ target: draft({ enabled: false }) }, U1)
    expect(target.enabled).toBe(false)
  })

  it('switch, test and delete work on an own target', async () => {
    const { target } = await nc['nc.upsertMyTarget']({ target: draft() }, U1)
    await expect(
      nc['nc.setMyTargetEnabled']({ targetId: target.id, enabled: false }, U1),
    ).resolves.toEqual({ success: true })
    expect((await nc['nc.listMyTargets']({}, U1)).targets[0]?.enabled).toBe(false)
    await expect(nc['nc.testMyTarget']({ targetId: target.id }, U1)).resolves.toMatchObject({
      success: true,
    })
    expect(tested).toEqual([target.id])
    await expect(nc['nc.deleteMyTarget']({ targetId: target.id }, U1)).resolves.toEqual({
      success: true,
    })
    expect((await nc['nc.listMyTargets']({}, U1)).targets).toEqual([])
  })

  it('refuses a foreign or global target, for an admin too, as FORBIDDEN', async () => {
    for (const id of ['b1', 'g1']) {
      for (const caller of [U1, ADMIN]) {
        await expect(nc['nc.deleteMyTarget']({ targetId: id }, caller)).rejects.toThrow(
          /^forbidden: /,
        )
        await expect(
          nc['nc.setMyTargetEnabled']({ targetId: id, enabled: false }, caller),
        ).rejects.toThrow(/^forbidden: /)
        await expect(nc['nc.testMyTarget']({ targetId: id }, caller)).rejects.toThrow(
          /^forbidden: /,
        )
      }
    }
    expect(await instances.getInstance({ id: 'b1' })).not.toBeNull()
    expect(tested).toEqual([])
  })

  it('fails closed without a caller', async () => {
    await expect(nc['nc.listMyTargets']({})).rejects.toThrow(/^forbidden: /)
    await expect(nc['nc.upsertMyTarget']({ target: draft() })).rejects.toThrow(/^forbidden: /)
    await expect(nc['nc.deleteMyTarget']({ targetId: 'g1' })).rejects.toThrow(/^forbidden: /)
    expect(await instances.getInstance({ id: 'g1' })).not.toBeNull()
  })
})
