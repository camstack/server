import { PetkitApiError, PetkitAuthError, PetkitTransportError } from '@apocaliss92/nodepetkit'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { PetkitConfig } from '../config.js'
import { type PetkitFacadeLike, PetkitIntegrationManager } from '../petkit-integration-manager.js'
import { MAX_RELOGINS_IN_WINDOW, RELOGIN_MAX_DELAY_MS } from '../petkit-relogin-gate.js'

const CONNECTION: PetkitConfig = {
  email: 'u@example.com',
  password: 'p',
  region: 'de',
  timezone: 'UTC',
  pollIntervalMs: 30_000,
}

const KICKED = new PetkitApiError('account logged in on another device (code 125)', 125)

interface LogLine {
  readonly level: string
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
}

function recordingLogger(lines: LogLine[]): IScopedLogger {
  const push =
    (level: string) =>
    (message: string, ctx?: { meta?: Record<string, unknown> }): void => {
      lines.push({ level, message, meta: ctx?.meta })
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

function harness(loginImpl: () => Promise<void> = async () => undefined) {
  const logins = { count: 0 }
  const lines: LogLine[] = []
  const clock = { now: 0 }
  const facade: PetkitFacadeLike = {
    login: async () => {
      logins.count += 1
      await loginImpl()
    },
    discoverDevices: async () => [],
    createDevice: async () => {
      throw new Error('unused')
    },
  }
  const manager = new PetkitIntegrationManager({
    id: 'int-1',
    name: 'Home',
    connection: CONNECTION,
    logger: recordingLogger(lines),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: { set: () => undefined },
    makeFacade: () => facade,
    session: {
      register: () => undefined,
      failure: () => undefined,
      ok: async () => undefined,
    },
    now: () => clock.now,
  })
  return { manager, logins, lines, clock }
}

describe('PetkitIntegrationManager session recovery', () => {
  it('re-logs in once when the session was ended by another login', async () => {
    const h = harness()
    await h.manager.start()
    await h.manager.recoverSession(KICKED)
    expect(h.logins.count).toBe(2)
    expect(h.manager.getInfo().status).toBe('connected')
    expect(
      h.lines.some((l) => l.message.includes('re-login') && l.meta?.['reason'] === 'kicked'),
    ).toBe(true)
  })

  it('a burst of failing polls produces ONE re-login, the rest are refused with a reason', async () => {
    const h = harness()
    await h.manager.start()
    await Promise.all(Array.from({ length: 10 }, () => h.manager.recoverSession(KICKED)))
    expect(h.logins.count).toBe(2)
    const refusals = h.lines.filter((l) => l.message.includes('re-login refused'))
    expect(refusals.length).toBeGreaterThan(0)
  })

  it('does not re-login for errors that are not a session loss', async () => {
    const h = harness()
    await h.manager.start()
    await h.manager.recoverSession(new PetkitTransportError('HTTP failed'))
    expect(h.logins.count).toBe(1)
  })

  it('does not re-login when the cloud rejected the credentials', async () => {
    const h = harness()
    await h.manager.start()
    await h.manager.recoverSession(new PetkitAuthError('bad credentials'))
    expect(h.logins.count).toBe(1)
  })

  it('stops after repeated kicks and says another app signed in', async () => {
    const h = harness()
    await h.manager.start()
    for (let i = 0; i < MAX_RELOGINS_IN_WINDOW + 3; i += 1) {
      await h.manager.recoverSession(KICKED)
      h.clock.now += RELOGIN_MAX_DELAY_MS
    }
    expect(h.logins.count).toBe(1 + MAX_RELOGINS_IN_WINDOW)
    const info = h.manager.getInfo()
    expect(info.status).toBe('error')
    expect(info.error).toMatch(/another app signed in/i)
    expect(info.error).toMatch(/family/i)
  })

  it('re-saving the account re-arms recovery', async () => {
    const h = harness()
    await h.manager.start()
    for (let i = 0; i < MAX_RELOGINS_IN_WINDOW + 1; i += 1) {
      await h.manager.recoverSession(KICKED)
      h.clock.now += RELOGIN_MAX_DELAY_MS
    }
    const before = h.logins.count
    await h.manager.applyConnection({ ...CONNECTION, password: 'new' })
    await h.manager.recoverSession(KICKED)
    expect(h.logins.count).toBe(before + 2)
  })

  it('a failed re-login stays armed and is retried after the delay', async () => {
    let failNext = false
    const h = harness(async () => {
      if (failNext) throw new PetkitTransportError('network down')
    })
    await h.manager.start()
    failNext = true
    await h.manager.recoverSession(KICKED)
    expect(h.logins.count).toBe(2)
    failNext = false
    h.clock.now += RELOGIN_MAX_DELAY_MS
    await h.manager.recoverSession(KICKED)
    expect(h.logins.count).toBe(3)
    expect(h.manager.getInfo().status).toBe('connected')
  })
})
