import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ReolinkEmailPushServer } from '../email-push-server.js'
import { readEmailPushStore } from '../email-push-store.js'

/**
 * The SMTP AUTH password is hidden state kept in the keychain (D787): the raw
 * addon store holds a `{ $secret }` MARKER, never the value.
 *
 * Read raw, the marker is "not a string" → the server took it as ABSENT,
 * bootstrapped a fresh random password and persisted it — a new keychain
 * value, a config change, a restart, the marker again… On the live hub after
 * the keychain migration that loop rebound the SMTP intake ~4×/s and rotated
 * the password the cameras were provisioned with on every turn.
 */

const MARKER = {
  $secret: 'secret://provider-reolink/addon/emailPushAuthPassword',
}

function silentLogger(): IScopedLogger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  }
  return logger as unknown as IScopedLogger
}

function serverOver(store: Record<string, unknown>) {
  const writeStore = vi.fn(async (_patch: Record<string, unknown>) => {})
  const logger = silentLogger()
  const server = new ReolinkEmailPushServer({
    logger,
    listCameras: () => [],
    // Disabled: start() resolves settings and returns without binding a port.
    readStore: async () => ({ emailPushEnabled: false, ...store }),
    writeStore,
  })
  return { server, writeStore, logger }
}

describe('readEmailPushStore — the store the SMTP intake reads', () => {
  it('carries the keychain VALUE of the password, not the stored marker', async () => {
    const store = await readEmailPushStore({
      readRaw: async () => ({
        emailPushAuthUsername: 'camstack-ab12',
        emailPushAuthPassword: MARKER,
      }),
      readPassword: async () => 'the-kept-password',
    })
    expect(store['emailPushAuthPassword']).toBe('the-kept-password')
    expect(store['emailPushAuthUsername']).toBe('camstack-ab12')
  })

  it('leaves the marker in place when the keychain could not resolve it', async () => {
    const store = await readEmailPushStore({
      readRaw: async () => ({ emailPushAuthPassword: MARKER }),
      readPassword: async () => '',
    })
    expect(store['emailPushAuthPassword']).toEqual(MARKER)
  })

  it('a store with no password at all stays without one (first boot bootstraps)', async () => {
    const store = await readEmailPushStore({
      readRaw: async () => ({}),
      readPassword: async () => '',
    })
    expect('emailPushAuthPassword' in store).toBe(false)
  })
})

describe('ReolinkEmailPushServer — a stored password is never re-bootstrapped', () => {
  it('does not persist a new password over a keychain marker it could not resolve', async () => {
    const { server, writeStore, logger } = serverOver({
      emailPushAuthUsername: 'camstack-ab12',
      emailPushAuthPassword: MARKER,
    })
    await server.start()
    const persistedPassword = writeStore.mock.calls.some(
      ([patch]) => 'emailPushAuthPassword' in patch,
    )
    expect(persistedPassword).toBe(false)
    expect(logger.error).toHaveBeenCalled()
  })

  it('a restart over an unresolved marker still writes nothing', async () => {
    const { server, writeStore } = serverOver({
      emailPushAuthUsername: 'camstack-ab12',
      emailPushAuthPassword: MARKER,
    })
    await server.start()
    await server.restart()
    await server.restart()
    expect(writeStore).not.toHaveBeenCalled()
  })

  it('uses a resolved password as-is and writes nothing', async () => {
    const { server, writeStore } = serverOver({
      emailPushAuthUsername: 'camstack-ab12',
      emailPushAuthPassword: 'the-kept-password',
    })
    await server.start()
    expect(writeStore).not.toHaveBeenCalled()
  })

  it('still bootstraps credentials on a genuinely empty store', async () => {
    const { server, writeStore } = serverOver({})
    await server.start()
    expect(writeStore).toHaveBeenCalledTimes(1)
    const [patch] = writeStore.mock.calls[0]!
    expect(typeof patch['emailPushAuthPassword']).toBe('string')
    expect(typeof patch['emailPushAuthUsername']).toBe('string')
  })
})
