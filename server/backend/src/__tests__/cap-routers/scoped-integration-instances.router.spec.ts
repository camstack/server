/**
 * The user-scoped `integration-instances` door as the hub serves it (epic #440): a REAL registry,
 * the REAL `createCapRouterServices` (so `userScopedAdmission` is the one asked), the REAL
 * scoped notification-target provider over in-memory records. A faked `admitsUserCaller` is the
 * very thing that would supply the answer production forgot to fetch.
 */
import { buildCapRouters, CapabilityRegistry } from '@camstack/server/system'
import {
  buildUserScopedNotificationTargetInstances,
  integrationInstancesCapability,
  type IScopedLogger,
  kebabToCamel,
  makeInMemoryRecords,
  notificationTargetKinds,
  type TargetKind,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type CapProxyProvider,
  createCapRouterPrimitives,
  createCapRouterServices,
} from '../../api/trpc/cap-router-runtime.js'
import { type CreateCallerCapableRouter, invokeProcedure, makeCtx } from './harness.js'

const ADDON = 'notifiers'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

const NTFY: TargetKind = {
  kind: 'ntfy',
  label: 'ntfy',
  icon: 'ntfy',
  addonId: ADDON,
  supportsDiscovery: false,
  configSchema: {
    sections: [
      { id: 'ntfy', title: 'ntfy', fields: [{ type: 'text', key: 'topic', label: 'Topic' }] },
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

async function buildRouter(): Promise<CreateCallerCapableRouter> {
  const logger = makeLogger()
  const memory = makeInMemoryRecords(ADDON)
  const kinds = notificationTargetKinds([NTFY])
  await memory.records.declare(kinds)
  let seq = 0
  const notifiers = buildUserScopedNotificationTargetInstances(
    memory.records,
    {
      descriptors: [NTFY],
      kinds,
      mintId: () => `minted-${++seq}`,
      canProbe: () => false,
      probe: async () => ({ ok: true, resolvedUrl: 'x' }),
    },
    logger,
  )
  // Rows that exist before any user acts: one global, one per user.
  await notifiers.createInstance({ id: 'global', name: 'House', kind: 'ntfy', values: {} })
  await notifiers.createInstance({
    id: 'a1',
    name: 'Alice',
    kind: 'ntfy',
    values: { ownerUserId: 'u1' },
  })
  await notifiers.createInstance({
    id: 'b1',
    name: 'Bob',
    kind: 'ntfy',
    values: { ownerUserId: 'u2' },
  })
  // A second integration-instances provider whose rows do NOT belong to users: admin only.
  const adminOnly = {
    describe: async () => ({ role: 'services', instanceMode: 'multiple', kind: 'x' }),
    listInstances: async () => [],
  }
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(integrationInstancesCapability)
  registry.registerProvider('integration-instances', ADDON, notifiers)
  registry.registerProvider('integration-instances', 'plain', adminOnly)
  const moleculer: CapProxyProvider = { createCapabilityProxy: () => null }
  const services = createCapRouterServices({
    capabilityRegistry: registry,
    moleculer,
    serverProviders: {},
    logger,
  })
  const router = buildCapRouters(createCapRouterPrimitives(), services)[
    kebabToCamel('integration-instances')
  ]
  if (router === undefined) throw new Error('no integration-instances router built')
  return router as CreateCallerCapableRouter
}

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((row: { id?: unknown }) => (typeof row.id === 'string' ? [row.id] : []))
    : []

describe('integration-instances: the user-scoped door through the real router', () => {
  const alice = () => makeCtx('user', { id: 'u1' })

  it('a user lists only their own targets, an admin lists all', async () => {
    const router = await buildRouter()
    const mine = await invokeProcedure(router, 'listInstances', alice(), { addonId: ADDON })
    expect(mine.ok && ids(mine.value)).toEqual(['a1'])
    const all = await invokeProcedure(router, 'listInstances', makeCtx('admin'), {
      addonId: ADDON,
    })
    expect(all.ok && ids(all.value).sort()).toEqual(['a1', 'b1', 'global'])
  })

  it('a client-sent caller is discarded: the session decides who is asking', async () => {
    const router = await buildRouter()
    const forged = await invokeProcedure(router, 'listInstances', alice(), {
      addonId: ADDON,
      caller: { userId: 'root', isAdmin: true },
    })
    expect(forged.ok && ids(forged.value)).toEqual(['a1'])
    const asBob = await invokeProcedure(router, 'listInstances', alice(), {
      addonId: ADDON,
      caller: { userId: 'u2', isAdmin: false },
    })
    expect(asBob.ok && ids(asBob.value)).toEqual(['a1'])
  })

  it('a foreign target is refused for change and absent for read', async () => {
    const router = await buildRouter()
    const read = await invokeProcedure(router, 'getInstance', alice(), { addonId: ADDON, id: 'b1' })
    expect(read).toEqual({ ok: true, value: null })
    const del = await invokeProcedure(router, 'deleteInstance', alice(), {
      addonId: ADDON,
      id: 'b1',
    })
    expect(del.ok).toBe(false)
    const still = await invokeProcedure(router, 'getInstance', makeCtx('admin'), {
      addonId: ADDON,
      id: 'b1',
    })
    expect(still.ok && still.value).not.toBeNull()
  })

  it('a user creates under their own id whatever owner the client names', async () => {
    const router = await buildRouter()
    const created = await invokeProcedure(router, 'createInstance', alice(), {
      addonId: ADDON,
      name: 'Phone',
      kind: 'ntfy',
      values: { ownerUserId: 'u2' },
      caller: { userId: 'u2', isAdmin: false },
    })
    expect(created.ok).toBe(true)
    const mine = await invokeProcedure(router, 'listInstances', alice(), { addonId: ADDON })
    expect(mine.ok && ids(mine.value).sort()).toEqual(['a1', 'minted-1'])
    const bobs = await invokeProcedure(router, 'listInstances', makeCtx('user', { id: 'u2' }), {
      addonId: ADDON,
    })
    expect(bobs.ok && ids(bobs.value)).toEqual(['b1'])
  })

  it('a user is refused without a pin, and on a provider whose rows are not theirs', async () => {
    const router = await buildRouter()
    const unpinned = await invokeProcedure(router, 'listInstances', alice(), {})
    expect(unpinned).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const plain = await invokeProcedure(router, 'listInstances', alice(), { addonId: 'plain' })
    expect(plain).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})
