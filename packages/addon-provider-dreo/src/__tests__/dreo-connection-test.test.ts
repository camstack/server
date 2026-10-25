import { DreoAuthError, DreoTransportError } from '@apocaliss92/nodedreo'
import { describe, expect, it, vi } from 'vitest'
import type { DreoConfig } from '../config.js'
import { buildDreoConnectionTestProvider } from '../dreo-connection-test.js'
import type { DreoFacadeLike } from '../dreo-integration-manager.js'

/**
 * The fake behaves like the real Dreo cloud: exactly ONE password is accepted,
 * and a wrong one comes back as `DreoAuthError` — the same class the library
 * throws. A fake that always resolved would make the gate look correct while
 * gating on nothing.
 */
const GOOD_PASSWORD = 'the-real-password'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeFacadeFactory(mode: 'cloud' | 'unreachable') {
  const close = vi.fn()
  const factory = (config: DreoConfig): DreoFacadeLike => ({
    login: async () => {
      if (mode === 'unreachable') throw new DreoTransportError('getaddrinfo ENOTFOUND')
      if (config.password !== GOOD_PASSWORD) throw new DreoAuthError('invalid account or password')
    },
    discoverDevices: async () => [],
    connect: async () => undefined,
    createDevice: async () => {
      throw new Error('not used')
    },
    close,
  })
  return { factory, close }
}

function build(mode: 'cloud' | 'unreachable' = 'cloud') {
  const { factory, close } = makeFacadeFactory(mode)
  const logger = makeLogger()
  return {
    provider: buildDreoConnectionTestProvider({ makeFacade: factory, logger: logger as never }),
    close,
    logger,
  }
}

describe('Dreo connection-test — pre-creation credential validation', () => {
  it('VALIDATES the correct account credentials', async () => {
    const h = build()
    const outcome = await h.provider.testSettings({
      settings: { email: 'a@b.com', password: GOOD_PASSWORD, region: 'us' },
    })
    expect(outcome.outcome).toBe('validated')
    expect(h.close).toHaveBeenCalled()
  })

  it('REJECTS a wrong password — the operator’s live case', async () => {
    const h = build()
    const outcome = await h.provider.testSettings({
      settings: { email: 'a@b.com', password: 'wrong', region: 'us' },
    })
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome !== 'rejected') throw new Error('unreachable')
    expect(outcome.error).toMatch(/refused these credentials/)
    // Never echo the secret back to the client.
    expect(outcome.error).not.toContain('wrong')
    expect(h.close).toHaveBeenCalled()
  })

  it('REJECTS an incomplete form without a round trip', async () => {
    const h = build()
    const outcome = await h.provider.testSettings({ settings: { email: 'a@b.com' } })
    expect(outcome.outcome).toBe('rejected')
    // No facade was built, so nothing to close.
    expect(h.close).not.toHaveBeenCalled()
  })

  it('is INCONCLUSIVE — never rejected — when the cloud cannot be reached', async () => {
    const h = build('unreachable')
    const outcome = await h.provider.testSettings({
      settings: { email: 'a@b.com', password: GOOD_PASSWORD, region: 'us' },
    })
    // A transport fault says nothing about the credentials. Calling it a
    // rejection would block a good create whenever the network hiccups.
    expect(outcome.outcome).toBe('inconclusive')
    expect(h.close).toHaveBeenCalled()
  })

  it('describes what the test does, so the UI need not guess', async () => {
    const h = build()
    expect((await h.provider.describeTest()).label).toMatch(/Dreo/)
  })
})
