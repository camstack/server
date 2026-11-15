/**
 * Sign out on an EXISTING Home Connect instance acts on the instance record (the owner of the
 * tokens), and the reconcile that follows stops the integration's manager with its devices
 * offline — a signed-out integration is never treated as deleted.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { boschWorld } from '../../shared/__tests__/bosch-world.js'
import type { HomeConnectConfig } from '../config.js'
import { signOutHomeConnectInstance } from '../home-connect-account.js'
import { HomeConnectClientRegistry, type ManagerLike } from '../home-connect-client-registry.js'
import {
  buildHomeConnectInstances,
  HOME_CONNECT_MIGRATIONS,
  homeConnectConnectionOf,
  homeConnectRecordKinds,
  homeConnectRowsPorts,
  homeConnectStoredOf,
} from '../home-connect-instances.js'
import { reconcileHomeConnectIntegrations } from '../home-connect-reconcile.js'

const TOKEN = 'access-CANARY-1'
const REFRESH = 'refresh-CANARY-1'
const PSK = 'psk-CANARY-AAAA'
const INTEGRATION = { id: 'int_0050', addonId: 'bosch-home-connect', name: 'Home account' }
const APPLIANCE = {
  haId: 'HAI-1',
  name: 'Kitchen',
  type: 'Dishwasher',
  host: 'BOSCH-Dishwasher-HAI-1',
  mode: 'TLS',
  psk: PSK,
}

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
  stopped: number
}

function fakeManagers() {
  const made: FakeManager[] = []
  const makeManager = (opts: {
    readonly connection: HomeConnectConfig
    readonly integrationId: string
    readonly onConnected: (id: string) => void
    readonly onDisconnected: (id: string) => void
  }): ManagerLike => {
    let connection = opts.connection
    const m: FakeManager = {
      stopped: 0,
      start: async () => opts.onConnected(opts.integrationId),
      stop: async () => {
        m.stopped += 1
        opts.onDisconnected(opts.integrationId)
      },
      applyConnection: async (next: HomeConnectConfig) => {
        connection = next
      },
      getInfo: () => ({
        id: opts.integrationId,
        name: '',
        kind: 'home-connect',
        status: 'connected',
        info: { applianceCount: 1 },
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

async function setup() {
  const w = await boschWorld({
    addonId: 'bosch-home-connect',
    declare: (records) => records.declare(homeConnectRecordKinds),
    migrations: HOME_CONNECT_MIGRATIONS,
    ports: homeConnectRowsPorts,
    integration: INTEGRATION,
    rows: {
      token: TOKEN,
      refresh: REFRESH,
      accountLabel: 'me@example.com',
      appliances: [APPLIANCE],
    },
  })
  await w.run()
  const disconnected: string[] = []
  const signedOut: string[] = []
  const vanished: string[] = []
  const managers = fakeManagers()
  const registry = new HomeConnectClientRegistry(logger(), {
    makeManager: managers.makeManager,
    onDisconnected: (id) => disconnected.push(id),
  })
  let present: readonly { id: string; name: string }[] = [INTEGRATION]
  const reconcile = (): Promise<void> =>
    reconcileHomeConnectIntegrations({
      listEnabled: async () => present,
      knownIds: async () => (await built.instances.listResolved()).map((row) => row.id),
      storedOf: (id) => homeConnectStoredOf(built.instances, id),
      registry,
      onSignedOut: (id) => signedOut.push(id),
      onVanished: async (id) => void vanished.push(id),
      logger: logger(),
    })
  const built = buildHomeConnectInstances(w.mem.records, { onChanged: reconcile, tester })
  await reconcile()
  return {
    w,
    built,
    registry,
    managers,
    disconnected,
    signedOut,
    vanished,
    reconcile,
    setPresent: (next: readonly { id: string; name: string }[]) => {
      present = next
    },
  }
}

describe('Home Connect sign out on an existing instance', () => {
  it('clears token, refresh and pairing keys through the record and stops the manager, devices offline, nothing deleted', async () => {
    const s = await setup()
    expect(s.registry.has(INTEGRATION.id)).toBe(true)

    await signOutHomeConnectInstance(INTEGRATION.id, s.built.instances)

    expect(await homeConnectConnectionOf(s.built.instances, INTEGRATION.id)).toBeNull()
    const stored = await homeConnectStoredOf(s.built.instances, INTEGRATION.id)
    expect(stored?.settings).not.toHaveProperty('token')
    expect(stored?.settings).not.toHaveProperty('applianceSecrets')
    expect(stored?.settings['accountLabel']).toBe('')
    // The paired appliance list stays for the next sign in.
    expect(stored?.settings['appliances']).toEqual([
      expect.objectContaining({ haId: APPLIANCE.haId }),
    ])
    // No secret is left anywhere in the store: not in clear, not in the keychain table.
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

  it('a deleted integration is still vanished, even once signed out (no manager left)', async () => {
    const s = await setup()
    await signOutHomeConnectInstance(INTEGRATION.id, s.built.instances)
    s.setPresent([])
    await s.reconcile()
    expect(s.vanished).toEqual([INTEGRATION.id])
  })
})
