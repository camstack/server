/**
 * A `caller: 'scoped'` call crosses the REAL router, the REAL parent→child UDS
 * channel and `createChildCapDispatch` before the forked provider sees it.
 *
 * The server-derived identity (user id + role) is what the child filters on.
 * A `caller` the client put on the wire is overwritten before the hop, so the
 * child never sees it. Recording the args the provider method received — after
 * dispatch — is the observation: dropping `caller` inside `child-cap-dispatch`
 * makes these assertions fail.
 */
import type {
  CapCaller,
  IIntegrationInstancesProvider,
  IScopedLogger,
  TargetKind,
} from '@camstack/types'
import {
  buildUserScopedNotificationTargetInstances,
  integrationInstancesCapability,
  makeInMemoryRecords,
  notificationTargetKinds,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildOneCapRouter,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../../cap-router-builder.js'
import { createChildCapDispatch } from '../../moleculer/child-cap-dispatch.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'

const ADDON = 'notifiers'
const CAP = 'integration-instances'
const ALICE: CapCaller = { userId: 'u1', isAdmin: false }
const FORGED: CapCaller = { userId: 'u2', isAdmin: true }

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

interface SeenCall {
  readonly method: string
  readonly caller: CapCaller | undefined
}

interface RecordedProcedure {
  readonly call: (input: unknown, ctx: unknown) => unknown
  readonly schema: unknown
}

interface Harness {
  readonly call: (method: string, input: unknown, user: CapCaller) => Promise<unknown>
  readonly seen: readonly SeenCall[]
  readonly close: () => Promise<void>
}

function logger(): IScopedLogger {
  const log: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
    withTags: () => log,
  }
  return log
}

function readCaller(input: unknown): CapCaller | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw: unknown = Reflect.get(input, 'caller')
  if (typeof raw !== 'object' || raw === null) return undefined
  const userId: unknown = Reflect.get(raw, 'userId')
  const isAdmin: unknown = Reflect.get(raw, 'isAdmin')
  if (typeof userId !== 'string' || typeof isAdmin !== 'boolean') return undefined
  return { userId, isAdmin }
}

/** The forked provider, noting the caller each scoped method actually received. */
function watching(
  inner: IIntegrationInstancesProvider,
  seen: SeenCall[],
): IIntegrationInstancesProvider {
  return {
    ...inner,
    listInstances: (input) => {
      seen.push({ method: 'listInstances', caller: readCaller(input) })
      return inner.listInstances(input)
    },
    createInstance: (input) => {
      seen.push({ method: 'createInstance', caller: readCaller(input) })
      return inner.createInstance(input)
    },
  }
}

function makeProcedureBuilder(): ProcedureBuilder {
  let declared: unknown
  const builder: ProcedureBuilder = {
    input(schema) {
      declared = schema
      return builder
    },
    output() {
      return builder
    },
    query(resolver) {
      const proc: RecordedProcedure = {
        call: (input, ctx) => resolver({ input, ctx }),
        schema: declared,
      }
      return proc
    },
    mutation(resolver) {
      const proc: RecordedProcedure = {
        call: (input, ctx) => resolver({ input, ctx }),
        schema: declared,
      }
      return proc
    },
    subscription(resolver) {
      const proc: RecordedProcedure = {
        call: (input, ctx) => resolver({ input, ctx }),
        schema: declared,
      }
      return proc
    },
  }
  return builder
}

function makePrimitives(): CapRouterPrimitives {
  return {
    router: (procs) => procs,
    procedures: {
      public: makeProcedureBuilder(),
      protected: makeProcedureBuilder(),
      admin: makeProcedureBuilder(),
    },
    iterableSubscription: <T>(subscribe: (push: (value: T) => void) => () => void) => {
      async function* gen(): AsyncGenerator<T> {
        const values: T[] = []
        const unsub = subscribe((v) => values.push(v))
        try {
          for (const v of values) yield v
        } finally {
          unsub()
        }
      }
      return gen()
    },
  }
}

function isCall(value: unknown): value is (input: unknown, ctx: unknown) => unknown {
  return typeof value === 'function'
}

function procedureOf(router: unknown, name: string): RecordedProcedure {
  if (typeof router !== 'object' || router === null) throw new Error('cap router was not an object')
  const proc: unknown = Reflect.get(router, name)
  if (typeof proc !== 'object' || proc === null) throw new Error(`no procedure ${name}`)
  const call: unknown = Reflect.get(proc, 'call')
  if (!isCall(call)) throw new Error(`procedure ${name} has no call`)
  return { call, schema: Reflect.get(proc, 'schema') }
}

interface ParseResult {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: { readonly message: string }
}

function isParser(value: unknown): value is { safeParse: (input: unknown) => ParseResult } {
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'safeParse') === 'function'
}

/** What tRPC does before the resolver: parse the wire value with the declared schema. */
function parseWire(schema: unknown, input: unknown): unknown {
  if (!isParser(schema)) return input
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error?.message ?? 'input rejected')
  return parsed.data
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('list did not return an array')
  const ids: string[] = []
  for (const row of value) {
    if (typeof row === 'object' && row !== null && typeof Reflect.get(row, 'id') === 'string') {
      const id: unknown = Reflect.get(row, 'id')
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

interface Session {
  readonly user: { readonly id: string; readonly isAdmin: boolean }
}

function session(user: CapCaller): Session {
  return { user: { id: user.userId, isAdmin: user.isAdmin } }
}

async function userScopedAdmission(
  capName: string,
  provider: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (capName !== CAP) return false
  const describe = provider.describe
  if (typeof describe !== 'function') return false
  const description: unknown = await describe.call(provider)
  return (
    typeof description === 'object' &&
    description !== null &&
    Reflect.get(description, 'userScoped') === true
  )
}

async function seedDoor(): Promise<{ door: IIntegrationInstancesProvider; seen: SeenCall[] }> {
  const memory = makeInMemoryRecords(ADDON)
  const kinds = notificationTargetKinds([NTFY])
  await memory.records.declare(kinds)
  let seq = 0
  const seen: SeenCall[] = []
  const door = watching(
    buildUserScopedNotificationTargetInstances(
      memory.records,
      {
        descriptors: [NTFY],
        kinds,
        mintId: () => `minted-${++seq}`,
        canProbe: () => false,
        probe: async () => ({ ok: true, resolvedUrl: 'x' }),
      },
      logger(),
    ),
    seen,
  )
  await door.createInstance({ id: 'global', name: 'House', kind: 'ntfy', values: { topic: 'g' } })
  await door.createInstance({
    id: 'a1',
    name: 'Alice',
    kind: 'ntfy',
    values: { topic: 'a', ownerUserId: 'u1' },
  })
  await door.createInstance({
    id: 'b1',
    name: 'Bob',
    kind: 'ntfy',
    values: { topic: 'b', ownerUserId: 'u2' },
  })
  seen.length = 0
  return { door, seen }
}

type HopMethod = (input?: unknown) => Promise<unknown>

/** The hub-side provider: every method is a real `callCapOnChild`, not an in-process call. */
function udsProvider(registry: LocalChildRegistry): Record<string, HopMethod> {
  const hop =
    (method: string): HopMethod =>
    (input) =>
      registry.callCapOnChild(ADDON, {
        capName: CAP,
        method,
        args: input ?? {},
        addonId: ADDON,
      })
  return {
    describe: hop('describe'),
    listInstances: hop('listInstances'),
    createInstance: hop('createInstance'),
  }
}

function routerServices(provider: Record<string, HopMethod>): CapRouterServices {
  const raise = (prefix: string) => (message: string) => {
    throw new Error(`${prefix}:${message}`)
  }
  return {
    getLocalProvider: (capName, _mount, _ctx, addonId) =>
      capName === CAP && addonId === ADDON ? provider : null,
    remoteProxy: () => null,
    noProvider: (capName) => raise('noProvider')(capName),
    noNodeRouting: (capName) => raise('noNodeRouting')(capName),
    badRequest: raise('badRequest'),
    unauthorized: raise('unauthorized'),
    forbidden: raise('forbidden'),
    admitsUserCaller: userScopedAdmission,
  }
}

async function openHarness(): Promise<Harness> {
  const { door, seen } = await seedDoor()
  const nodeId = `scoped-caller-${process.pid}-${Math.random().toString(36).slice(2)}`
  const registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
  await registry.start()
  const child = new LocalChildClient({
    nodeId,
    childId: ADDON,
    caps: [{ capName: CAP, mode: 'collection', addonId: ADDON }],
    dispatch: createChildCapDispatch({
      getSingletonProvider: (capName) => (capName === CAP ? door : null),
      getDeviceProvider: () => null,
      isCollectionListMethod: (capName, method) => capName === CAP && method === 'listInstances',
      isProviderOptionalMethod: () => false,
    }),
  })
  await child.start()
  const router = buildOneCapRouter(
    integrationInstancesCapability,
    makePrimitives(),
    routerServices(udsProvider(registry)),
  )
  return {
    seen,
    call: async (method, input, user) => {
      const proc = procedureOf(router, method)
      return proc.call(parseWire(proc.schema, input), session(user))
    },
    close: async () => {
      await child.close()
      await registry.close()
    },
  }
}

describe("caller: 'scoped' survives the UDS hop into the forked provider", () => {
  let harness: Harness | null = null
  afterEach(async () => {
    await harness?.close()
    harness = null
  })

  it('delivers the server caller, and drops a client-supplied one, so a user lists only their rows', async () => {
    harness = await openHarness()
    const listed = await harness.call('listInstances', { addonId: ADDON, caller: FORGED }, ALICE)
    expect(idsOf(listed).sort()).toEqual(['a1'])
    expect(harness.seen).toEqual([{ method: 'listInstances', caller: ALICE }])
  })

  it('stamps a create from the server caller the child received, not the owner the client named', async () => {
    harness = await openHarness()
    const created = await harness.call(
      'createInstance',
      {
        addonId: ADDON,
        name: 'Phone',
        kind: 'ntfy',
        values: { topic: 't', ownerUserId: 'u2' },
        caller: FORGED,
      },
      ALICE,
    )
    expect(harness.seen).toEqual([{ method: 'createInstance', caller: ALICE }])
    const listed = await harness.call('listInstances', { addonId: ADDON }, ALICE)
    expect(idsOf(listed).sort()).toEqual(['a1', 'minted-1'])
    expect(created).toEqual({ id: 'minted-1' })
    const bob = await harness.call(
      'listInstances',
      { addonId: ADDON },
      { userId: 'u2', isAdmin: false },
    )
    expect(idsOf(bob)).toEqual(['b1'])
  })
})
