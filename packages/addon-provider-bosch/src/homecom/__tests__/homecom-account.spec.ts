/**
 * Sign out and sign in on an EXISTING HomeCom instance act on the instance record (the owner of
 * the tokens), and the reconcile that follows stops or restarts the integration's manager. A
 * signed-out integration is stopped with its devices offline — never treated as deleted.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import { boschWorld } from '../../shared/__tests__/bosch-world.js'
import type { HomeComConfig } from '../config.js'
import {
  signOutHomeComInstance,
  storedSignInResult,
  storeHomeComSignIn,
} from '../homecom-account.js'
import { HomeComClientRegistry, type ManagerLike } from '../homecom-client-registry.js'
import {
  buildHomeComInstances,
  HOMECOM_MIGRATIONS,
  homeComConnectionOf,
  homeComRecordKinds,
  homeComRowsPorts,
} from '../homecom-instances.js'
import { reconcileHomeComIntegrations } from '../homecom-reconcile.js'
import type { HomeComFinishedSignIn } from '../homecom-sign-in.js'

const TOKEN = 'access-CANARY-1'
const REFRESH = 'refresh-CANARY-1'
const EMAIL = 'me-CANARY@example.com'
const INTEGRATION = { id: 'int_0040', addonId: 'bosch-homecom', name: 'Home account' }

const tester = { testSettings: async () => ({ outcome: 'validated' as const }) }

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

interface FakeManager extends ManagerLike {
  readonly applied: HomeComConfig[]
  stopped: number
}

function fakeManagers() {
  const made: FakeManager[] = []
  const makeManager = (opts: {
    readonly connection: HomeComConfig
    readonly integrationId: string
    readonly onConnected: (id: string) => void
    readonly onDisconnected: (id: string) => void
  }): ManagerLike => {
    let connection = opts.connection
    const m: FakeManager = {
      applied: [],
      stopped: 0,
      start: async () => opts.onConnected(opts.integrationId),
      stop: async () => {
        m.stopped += 1
        opts.onDisconnected(opts.integrationId)
      },
      applyConnection: async (next: HomeComConfig) => {
        m.applied.push(next)
        connection = next
        opts.onConnected(opts.integrationId)
      },
      getInfo: () => ({
        id: opts.integrationId,
        name: '',
        kind: 'homecom',
        status: 'connected',
        info: {},
        error: null,
        lastCheckedAt: null,
      }),
      getConnection: () => connection,
    }
    made.push(m)
    return m
  }
  return { made, makeManager }
}

interface SetupOptions {
  /** The keychain cannot serve this instance's secrets. */
  readonly locked?: boolean
  /** Integration ids only devices still name. */
  readonly deviceIds?: readonly string[]
}

async function setup(opts: SetupOptions = {}) {
  const w = await boschWorld({
    addonId: 'bosch-homecom',
    declare: (records) => records.declare(homeComRecordKinds),
    migrations: HOMECOM_MIGRATIONS,
    ports: homeComRowsPorts,
    integration: INTEGRATION,
    rows: {
      username: EMAIL,
      token: TOKEN,
      refresh: REFRESH,
      brand: 'bosch',
      region: 'eu',
      gatewayId: 'gw-77',
      accountLabel: 'Me',
      gatewayCount: 1,
    },
  })
  await w.run()
  const connected: string[] = []
  const disconnected: string[] = []
  const signedOut: string[] = []
  const vanished: string[] = []
  const managers = fakeManagers()
  const registry = new HomeComClientRegistry(logger(), {
    makeManager: managers.makeManager,
    onConnected: (id) => connected.push(id),
    onDisconnected: (id) => disconnected.push(id),
  })
  let present: readonly { id: string; name: string }[] = [INTEGRATION]
  const reconcile = (): Promise<void> =>
    reconcileHomeComIntegrations({
      listEnabled: async () => present,
      knownIds: async () => [
        ...(await built.instances.listResolved()).map((row) => row.id),
        ...(opts.deviceIds ?? []),
      ],
      connectionOf: async (id) => {
        if (opts.locked === true) throw new Error('the keychain is locked')
        return homeComConnectionOf(built.instances, id)
      },
      registry,
      onNamed: () => undefined,
      onSignedOut: (id) => signedOut.push(id),
      onVanished: async (id) => void vanished.push(id),
      logger: logger(),
    })
  const built = buildHomeComInstances(w.mem.records, { onChanged: reconcile, tester })
  await reconcile()
  return {
    w,
    built,
    registry,
    managers,
    connected,
    disconnected,
    signedOut,
    vanished,
    setPresent: (next: readonly { id: string; name: string }[]) => {
      present = next
    },
    reconcile,
  }
}

describe('HomeCom sign out on an existing instance', () => {
  it('clears the stored tokens through the instance record and stops the manager, devices offline, nothing deleted', async () => {
    const s = await setup()
    expect(s.registry.has(INTEGRATION.id)).toBe(true)

    await signOutHomeComInstance(INTEGRATION.id, s.built.instances)

    expect(await homeComConnectionOf(s.built.instances, INTEGRATION.id)).toBeNull()
    expect(JSON.stringify([...s.w.mem.tables.values()].map((t) => [...t.values()]))).not.toMatch(
      /CANARY/,
    )
    expect(s.registry.has(INTEGRATION.id)).toBe(false)
    expect(s.managers.made[0]?.stopped).toBe(1)
    expect(s.disconnected).toEqual([INTEGRATION.id])
    expect(s.signedOut).toEqual([INTEGRATION.id])
    // A signed-out integration is not a deleted one: its devices are not cascaded away.
    expect(s.vanished).toEqual([])
  })

  it('a deleted integration is still vanished', async () => {
    const s = await setup()
    s.setPresent([])
    await s.reconcile()
    expect(s.vanished).toEqual([INTEGRATION.id])
  })
})

describe('HomeCom sign in on an existing instance', () => {
  const finished: HomeComFinishedSignIn = {
    token: 'access-NEW',
    refresh: 'refresh-NEW',
    username: EMAIL,
    accountLabel: EMAIL,
    gatewayCount: 1,
    gatewayId: 'gw-77',
    brand: 'bosch',
    region: 'eu',
    summary: 'Signed in.',
  }

  it('stores the new tokens and the running manager applies the new connection', async () => {
    const s = await setup()
    s.connected.length = 0
    await storeHomeComSignIn(INTEGRATION.id, finished, s.built.instances)
    expect(await homeComConnectionOf(s.built.instances, INTEGRATION.id)).toMatchObject({
      token: 'access-NEW',
      refresh: 'refresh-NEW',
    })
    expect(s.managers.made[0]?.applied.map((c) => c.token)).toEqual(['access-NEW'])
    expect(s.connected).toEqual([INTEGRATION.id])
  })

  it('after a sign out, signing in again starts a manager on the new tokens', async () => {
    const s = await setup()
    await signOutHomeComInstance(INTEGRATION.id, s.built.instances)
    s.connected.length = 0
    await storeHomeComSignIn(INTEGRATION.id, finished, s.built.instances)
    expect(s.registry.has(INTEGRATION.id)).toBe(true)
    expect(s.managers.made).toHaveLength(2)
    expect(s.managers.made[1]?.getConnection().token).toBe('access-NEW')
    expect(s.connected).toEqual([INTEGRATION.id])
  })

  it('keeps the stored gateway when the sign-in did not settle on one', async () => {
    const s = await setup()
    const { gatewayId: _g, brand: _b, region: _r, ...noGateway } = finished
    await storeHomeComSignIn(INTEGRATION.id, { ...noGateway, gatewayCount: 2 }, s.built.instances)
    expect(await homeComConnectionOf(s.built.instances, INTEGRATION.id)).toMatchObject({
      token: 'access-NEW',
      gatewayId: 'gw-77',
    })
  })
})

describe('HomeCom reconcile — what counts as gone', () => {
  it('signed out, then deleted: its devices and alert are dropped', async () => {
    const s = await setup()
    await signOutHomeComInstance(INTEGRATION.id, s.built.instances)
    expect(s.vanished).toEqual([])
    s.setPresent([])
    await s.reconcile()
    expect(s.vanished).toEqual([INTEGRATION.id])
  })

  it('unreadable at boot, then deleted: dropped, though no manager ever ran', async () => {
    const s = await setup({ locked: true, deviceIds: ['int_0099'] })
    expect(s.registry.has(INTEGRATION.id)).toBe(false)
    // A device naming an integration that no longer exists is dropped on every pass.
    expect(s.vanished).toEqual(['int_0099'])
    s.vanished.length = 0
    s.setPresent([])
    await s.reconcile()
    expect([...s.vanished].sort()).toEqual([INTEGRATION.id, 'int_0099'])
  })

  it('unreadable and still present: untouched', async () => {
    const s = await setup({ locked: true })
    await s.reconcile()
    expect(s.vanished).toEqual([])
    expect(s.signedOut).toEqual([])
    expect(s.disconnected).toEqual([])
  })
})

describe('HomeCom sign in on an existing instance — what the browser gets back', () => {
  it('carries no secret in clear: the stored tokens come back as set views', async () => {
    const s = await setup()
    const finished: HomeComFinishedSignIn = {
      token: 'access-SECRET-NEW',
      refresh: 'refresh-SECRET-NEW',
      username: 'user-SECRET@example.com',
      accountLabel: 'Me',
      gatewayCount: 1,
      gatewayId: 'gw-77',
      summary: 'Signed in.',
    }
    await storeHomeComSignIn(INTEGRATION.id, finished, s.built.instances)
    const result = await storedSignInResult(INTEGRATION.id, finished, s.built.handle)
    expect(JSON.stringify(result)).not.toMatch(/SECRET/)
    expect(result.token).toMatchObject({ set: true })
    expect(result.refresh).toMatchObject({ set: true })
    expect(result).toMatchObject({ accountLabel: 'Me', gatewayCount: 1, gatewayId: 'gw-77' })
  })
})
