/**
 * VeSync binds every token to the `terminalId` the sign-in presented, and mails the account a
 * "new login" for every terminal it has not seen. The integration therefore presents ONE terminal
 * id per integration, kept with its stored session, on every client it builds — across restarts,
 * fresh sign-ins and credential changes. A session stored before the terminal id was kept (the
 * tsvesync 1.4 era) loads, is adopted or refused like any other, and gains a terminal id.
 */
import { createDurableState, type IScopedLogger } from '@camstack/types'
import { VeSync } from 'tsvesync'
import { describe, expect, it } from 'vitest'
import { vesyncConnectionSchema, type VeSyncConnectionConfig } from '../config.js'
import {
  type VeSyncClient,
  type VeSyncClientFactory,
  type VeSyncSession,
  VeSyncSessionRejectedError,
} from '../vesync-client-contract.js'
import { VeSyncIntegrationManager } from '../vesync-integration-manager.js'
import {
  createVeSyncSessionStore,
  vesyncCredentialsFingerprint,
  vesyncStoredSessionsSchema,
} from '../vesync-session-store.js'
import {
  createTsVeSyncClientFactory,
  createTsVeSyncLibraryManager,
  type TsVeSyncLogSink,
  type TsVeSyncManager,
} from '../vesync-tsvesync-client.js'

const NOW_S = Math.floor(Date.now() / 1000)
const OFFICIAL_APP_ID = 'eldodkfj'

const CONNECTION: VeSyncConnectionConfig = vesyncConnectionSchema.parse({
  email: 'me@example.com',
  password: 'pw',
  region: 'EU',
  countryCode: 'IT',
})
const FINGERPRINT = vesyncCredentialsFingerprint(CONNECTION)

const silentSink: TsVeSyncLogSink = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

/** A row as tsvesync 1.4 left it: no terminal id, the old random app id never stored. */
const LEGACY_ROW = {
  integrationId: 'int_1',
  fingerprint: FINGERPRINT,
  token: 'tok-LEGACY',
  accountId: 'acct-1',
  countryCode: 'IT',
  region: 'EU',
  apiBaseUrl: 'https://smartapi.vesync.eu',
  authFlowUsed: 'new',
  issuedAt: NOW_S - 60,
  expiresAt: NOW_S + 86_400,
}

interface Built {
  readonly terminalId: string | undefined
  readonly restored: VeSyncSession[]
}

/**
 * A store over a raw blob (so a legacy row is read the way the addon reads it) and a fake client
 * that, like the library, reports the terminal id it presented on every session it mints.
 */
function world(initialRows: readonly unknown[], opts: { refuseRestored?: boolean } = {}) {
  let blob: Record<string, unknown> = { vesyncSessions: initialRows }
  const state = createDurableState({
    key: 'vesyncSessions',
    schema: vesyncStoredSessionsSchema,
    fallback: [],
    read: async () => blob,
    write: async (patch) => {
      blob = { ...blob, ...patch }
    },
  })
  const store = createVeSyncSessionStore(state)
  const built: Built[] = []
  let minted = 0
  const makeClient: VeSyncClientFactory = (input) => {
    const record: Built = { terminalId: input.terminalId, restored: [] }
    built.push(record)
    let restoredPending = false
    const client: VeSyncClient = {
      login: async () => {
        restoredPending = false
        minted += 1
        input.onSession?.({
          token: `tok-NEW-${minted}`,
          accountId: 'acct-1',
          countryCode: 'IT',
          region: 'EU',
          apiBaseUrl: 'https://smartapi.vesync.eu',
          authFlowUsed: 'new',
          terminalId: input.terminalId ?? null,
          issuedAt: NOW_S,
          expiresAt: NOW_S + 30 * 86_400,
        })
      },
      restoreSession: (s) => {
        record.restored.push(s)
        restoredPending = true
      },
      logout: async () => undefined,
      listDevices: async () => {
        if (restoredPending && opts.refuseRestored === true) {
          restoredPending = false
          throw new VeSyncSessionRejectedError('token error')
        }
        restoredPending = false
        return []
      },
      getDevice: () => null,
      setPower: async () => undefined,
      setFanSpeed: async () => undefined,
      setMode: async () => undefined,
      setChildLock: async () => undefined,
      setDisplay: async () => undefined,
      setTargetHumidity: async () => undefined,
      refreshDevice: async () => null,
    }
    return client
  }
  const manager = (connection: VeSyncConnectionConfig = CONNECTION): VeSyncIntegrationManager =>
    new VeSyncIntegrationManager({
      id: 'int_1',
      name: 'Home',
      connection,
      logger: silentLogger,
      sessions: store,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
      makeClient,
    })
  return { built, manager, stored: () => state.get() }
}

describe('VeSync terminal id — one per integration, kept across restarts', () => {
  it('a restart presents the terminal id the first sign-in presented', async () => {
    const w = world([])
    const first = w.manager()
    await first.start()
    await first.stop()
    // A new manager = a process restart over the same store.
    const second = w.manager()
    await second.start()
    await second.stop()
    const [a, b] = w.built
    expect(a?.terminalId).toMatch(/^2[0-9a-f]{32}$/)
    expect(b?.terminalId).toBe(a?.terminalId)
    expect((await w.stored())[0]?.terminalId).toBe(a?.terminalId)
  })

  it('a fresh sign-in after a credential change keeps the same terminal', async () => {
    const w = world([])
    await w.manager().start()
    await w.manager(vesyncConnectionSchema.parse({ ...CONNECTION, password: 'pw2' })).start()
    const [a, b] = w.built
    expect(a?.terminalId).toMatch(/^2[0-9a-f]{32}$/)
    expect(b?.terminalId).toBe(a?.terminalId)
    expect((await w.stored())[0]?.terminalId).toBe(a?.terminalId)
  })

  it('a refused stored session signs in again on the stored terminal', async () => {
    const w = world([], { refuseRestored: true })
    await w.manager().start()
    await w.manager().start()
    const [a, b] = w.built
    expect(b?.restored).toHaveLength(1)
    expect(a?.terminalId).toMatch(/^2[0-9a-f]{32}$/)
    expect(b?.terminalId).toBe(a?.terminalId)
  })
})

describe('VeSync terminal id — a session stored before it was kept', () => {
  it('loads, is adopted, and gains a terminal id that the next start presents', async () => {
    const w = world([LEGACY_ROW])
    await w.manager().start()
    await w.manager().start()
    const [a, b] = w.built
    expect(a?.restored[0]?.token).toBe('tok-LEGACY')
    expect(a?.terminalId).toMatch(/^2[0-9a-f]{32}$/)
    const rows = await w.stored()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.token).toBe('tok-LEGACY')
    expect(rows[0]?.terminalId).toBe(a?.terminalId)
    expect(b?.terminalId).toBe(a?.terminalId)
  })

  it('refused by the cloud: one fresh sign-in, no error loop', async () => {
    const w = world([LEGACY_ROW], { refuseRestored: true })
    const mgr = w.manager()
    await mgr.start()
    expect(mgr.status).toBe('connected')
    const rows = await w.stored()
    expect(rows.map((r) => r.token)).toEqual(['tok-NEW-1'])
    expect(w.built[0]?.terminalId).toMatch(/^2[0-9a-f]{32}$/)
    expect(rows[0]?.terminalId).toBe(w.built[0]?.terminalId)
  })
})

describe('tsvesync adapter — terminal id', () => {
  function fakeManagerWorld() {
    const seen: (string | undefined)[] = []
    const hydrated: unknown[] = []
    const factory = createTsVeSyncClientFactory((input): TsVeSyncManager => {
      seen.push(input.terminalId)
      return {
        login: async () => {
          input.onTokenChange?.({
            token: 'tok-lib',
            accountId: 'acct-1',
            region: 'EU',
            apiBaseUrl: 'https://smartapi.vesync.eu',
            terminalId: input.terminalId ?? 'library-made',
            appId: OFFICIAL_APP_ID,
          })
          return true
        },
        getDevices: async () => true,
        hydrateSession: (s) => {
          hydrated.push(s)
        },
        fans: [],
      }
    })
    return { factory, seen, hydrated }
  }

  it('hands the terminal id to the library and reports it on the minted session', async () => {
    const w = fakeManagerWorld()
    const minted: VeSyncSession[] = []
    const client = w.factory({
      email: 'me@example.com',
      password: 'pw',
      region: 'EU',
      terminalId: '2abc',
      onSession: (s) => {
        minted.push(s)
      },
    })
    await client.login()
    expect(w.seen).toEqual(['2abc'])
    expect(minted[0]?.terminalId).toBe('2abc')
  })

  it('restores a stored terminal id with the session', () => {
    const w = fakeManagerWorld()
    const client = w.factory({ email: 'me@example.com', password: 'pw', region: 'EU' })
    client.restoreSession({
      token: 't',
      accountId: 'a',
      countryCode: null,
      region: 'EU',
      apiBaseUrl: 'https://smartapi.vesync.eu',
      authFlowUsed: null,
      terminalId: '2stored',
      issuedAt: null,
      expiresAt: null,
    })
    expect(w.hydrated).toEqual([expect.objectContaining({ terminalId: '2stored' })])
  })
})

describe('tsvesync library — identity (no network)', () => {
  const input = {
    email: 'me@example.com',
    password: 'pw',
    region: 'EU' as const,
    countryCode: 'IT',
    logger: silentSink,
  }

  it('presents the terminal id it was given and the official app id', () => {
    const manager = createTsVeSyncLibraryManager({ ...input, terminalId: '2fixed' })
    expect(manager).toBeInstanceOf(VeSync)
    if (!(manager instanceof VeSync)) return
    expect(manager.terminalId).toBe('2fixed')
    expect(manager.appId).toBe(OFFICIAL_APP_ID)
  })

  it('adopts a legacy session (no terminal id, an old random app id) without throwing', () => {
    const manager = createTsVeSyncLibraryManager({ ...input, terminalId: '2fixed' })
    if (!(manager instanceof VeSync)) throw new Error('not the library manager')
    manager.hydrateSession({
      token: 'tok-LEGACY',
      accountId: 'acct-1',
      region: 'EU',
      apiBaseUrl: 'https://smartapi.vesync.eu',
      appId: 'oldrand1',
    })
    expect(manager.token).toBe('tok-LEGACY')
    expect(manager.terminalId).toBe('2fixed')
    expect(manager.appId).toBe(OFFICIAL_APP_ID)
  })
})
