/**
 * The VeSync session survives a restart: a start adopts the stored session instead of signing in,
 * and signs in only when there is none, it expired, the credentials changed, or the cloud refused
 * it — and then persists the new one. Signing in on every restart is what VeSync answered with
 * "auth code expired".
 */
import { createDurableState, type IScopedLogger } from '@camstack/types'
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
  rowOfSession,
  vesyncCredentialsFingerprint,
  vesyncStoredSessionsSchema,
  type VeSyncStoredSessions,
} from '../vesync-session-store.js'

const NOW_S = Math.floor(Date.now() / 1000)
const OLD_TOKEN = 'tok-OLD-0123456789'
const NEW_TOKEN = 'tok-NEW-9876543210'

function session(token: string, expiresAt: number | null): VeSyncSession {
  return {
    token,
    accountId: 'acct-1',
    countryCode: 'IT',
    region: 'EU',
    apiBaseUrl: 'https://smartapi.vesync.eu',
    authFlowUsed: 'new',
    terminalId: '2persisted',
    issuedAt: NOW_S - 60,
    expiresAt,
  }
}

const CONNECTION: VeSyncConnectionConfig = vesyncConnectionSchema.parse({
  email: 'me@example.com',
  password: 'pw',
  region: 'EU',
  countryCode: 'IT',
})

interface LoggedLine {
  readonly level: string
  readonly text: string
}

function recordingLogger(lines: LoggedLine[]): IScopedLogger {
  const push =
    (level: string) =>
    (message: string, extra?: unknown): void => {
      lines.push({ level, text: `${message} ${JSON.stringify(extra ?? null)}` })
    }
  const logger: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface World {
  readonly calls: string[]
  readonly restored: VeSyncSession[]
  readonly stored: () => Promise<VeSyncStoredSessions>
  readonly lines: LoggedLine[]
  readonly manager: (connection?: VeSyncConnectionConfig) => VeSyncIntegrationManager
}

/**
 * A fake client: `login()` mints NEW_TOKEN and reports it like the library does; a restored
 * session is refused on the first list when `refuseRestored` says so.
 */
function world(initial: VeSyncStoredSessions, opts: { refuseRestored?: boolean } = {}): World {
  let blob: Record<string, unknown> = { vesyncSessions: initial }
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
  const calls: string[] = []
  const restored: VeSyncSession[] = []
  const lines: LoggedLine[] = []
  const makeClient: VeSyncClientFactory = (input) => {
    let restoredPending = false
    const client: VeSyncClient = {
      login: async () => {
        calls.push('login')
        restoredPending = false
        input.onSession?.(session(NEW_TOKEN, NOW_S + 30 * 86_400))
      },
      restoreSession: (s) => {
        calls.push('restore')
        restored.push(s)
        restoredPending = true
      },
      logout: async () => undefined,
      listDevices: async () => {
        calls.push('list')
        if (restoredPending && opts.refuseRestored === true) {
          restoredPending = false
          throw new VeSyncSessionRejectedError('token error')
        }
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
  return {
    calls,
    restored,
    lines,
    stored: () => state.get(),
    manager: (connection = CONNECTION) =>
      new VeSyncIntegrationManager({
        id: 'int_1',
        name: 'Home',
        connection,
        logger: recordingLogger(lines),
        sessions: store,
        onConnected: () => undefined,
        onDisconnected: () => undefined,
        onPolled: () => undefined,
        makeClient,
      }),
  }
}

const FINGERPRINT = vesyncCredentialsFingerprint(CONNECTION)

function startLine(lines: readonly LoggedLine[]): string {
  return lines.find((l) => /session restored|signed in/.test(l.text))?.text ?? ''
}

describe('VeSync session persistence', () => {
  it('a restart with a valid stored session adopts it and does not sign in', async () => {
    const w = world([rowOfSession('int_1', FINGERPRINT, session(OLD_TOKEN, NOW_S + 86_400))])
    const mgr = w.manager()
    await mgr.start()
    await mgr.stop()
    expect(w.calls).toEqual(['restore', 'list'])
    expect(w.restored[0]?.token).toBe(OLD_TOKEN)
    expect(startLine(w.lines)).toMatch(/session restored/)
  })

  it('a session without an expiry is adopted (the cloud decides)', async () => {
    const w = world([rowOfSession('int_1', FINGERPRINT, session(OLD_TOKEN, null))])
    await w.manager().start()
    expect(w.calls).not.toContain('login')
  })

  it('no stored session: signs in and saves the new one', async () => {
    const w = world([])
    await w.manager().start()
    expect(w.calls).toEqual(['login', 'list'])
    expect((await w.stored()).map((r) => r.token)).toEqual([NEW_TOKEN])
    expect(startLine(w.lines)).toMatch(/signed in.*none-stored/)
  })

  it('an expired (or about to expire) session: signs in and saves the new one', async () => {
    const w = world([rowOfSession('int_1', FINGERPRINT, session(OLD_TOKEN, NOW_S + 60))])
    await w.manager().start()
    expect(w.calls).toEqual(['login', 'list'])
    const rows = await w.stored()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.token).toBe(NEW_TOKEN)
    expect(startLine(w.lines)).toMatch(/signed in.*expired/)
  })

  it('a refused restored token: one fresh sign-in, the new session saved', async () => {
    const w = world([rowOfSession('int_1', FINGERPRINT, session(OLD_TOKEN, NOW_S + 86_400))], {
      refuseRestored: true,
    })
    await w.manager().start()
    expect(w.calls).toEqual(['restore', 'list', 'login', 'list'])
    expect((await w.stored()).map((r) => r.token)).toEqual([NEW_TOKEN])
    expect(startLine(w.lines)).toMatch(/signed in.*rejected/)
  })

  it.each([
    ['email', { email: 'other@example.com' }],
    ['password', { password: 'pw2' }],
    ['country code', { countryCode: 'DE' }],
    ['region', { region: 'US' }],
  ])('a changed %s ignores the stored session and replaces it', async (_what, change) => {
    const w = world([rowOfSession('int_1', FINGERPRINT, session(OLD_TOKEN, NOW_S + 86_400))])
    const changed = vesyncConnectionSchema.parse({ ...CONNECTION, ...change })
    await w.manager(changed).start()
    expect(w.calls).toEqual(['login', 'list'])
    const rows = await w.stored()
    expect(rows.map((r) => r.token)).toEqual([NEW_TOKEN])
    expect(rows[0]?.fingerprint).toBe(vesyncCredentialsFingerprint(changed))
    expect(startLine(w.lines)).toMatch(/signed in.*account-changed/)
  })

  it('a session minted mid-run (library re-login) is saved too', async () => {
    const w = world([rowOfSession('int_1', FINGERPRINT, session(OLD_TOKEN, NOW_S + 86_400))])
    const mgr = w.manager()
    await mgr.start()
    await mgr.client?.login()
    await mgr.flushSessionWrites()
    expect((await w.stored()).map((r) => r.token)).toEqual([NEW_TOKEN])
  })

  it('forgetSession clears the stored row (integration deleted)', async () => {
    const w = world([rowOfSession('int_1', FINGERPRINT, session(OLD_TOKEN, NOW_S + 86_400))])
    const mgr = w.manager()
    await mgr.stop()
    await mgr.forgetSession()
    expect(await w.stored()).toEqual([])
  })

  it('the token never reaches a log line', async () => {
    const w = world([rowOfSession('int_1', FINGERPRINT, session(OLD_TOKEN, NOW_S + 86_400))], {
      refuseRestored: true,
    })
    const mgr = w.manager()
    await mgr.start()
    await mgr.stop()
    expect(w.lines.length).toBeGreaterThan(0)
    for (const line of w.lines) {
      expect(line.text).not.toContain(OLD_TOKEN)
      expect(line.text).not.toContain(NEW_TOKEN)
      expect(line.text).not.toContain(FINGERPRINT)
    }
  })
})
