import { describe, expect, it, vi } from 'vitest'
import type { DreoConfig } from '../config.js'
import { DreoBridgeError } from '../dreo-bridge.js'
import { buildDreoConnectionTestProvider } from '../dreo-connection-test.js'
import { FakeBridge } from './fake-bridge.js'

/**
 * The fake behaves like the real Dreo cloud: exactly ONE password is accepted, and a wrong
 * one comes back as the worker's `auth` code — the one the worker answers. A fake that always
 * resolved would make the gate look correct while gating on nothing.
 */
const GOOD_PASSWORD = 'the-real-password'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function build(mode: 'cloud' | 'unreachable' | 'no-python' = 'cloud') {
  const bridges: FakeBridge[] = []
  const provider = buildDreoConnectionTestProvider({
    makeBridge: () => {
      if (mode === 'no-python') throw new Error('Dreo needs the embedded Python')
      const bridge = new FakeBridge()
      const login = bridge.login.bind(bridge)
      bridge.login = async (config: DreoConfig) => {
        if (mode === 'unreachable')
          throw new DreoBridgeError('unreachable', 'getaddrinfo ENOTFOUND')
        if (config.password !== GOOD_PASSWORD) throw new DreoBridgeError('auth', 'refused')
        return login(config)
      }
      bridges.push(bridge)
      return bridge
    },
    logger: makeLogger() as never,
  })
  return { provider, bridges }
}

describe('Dreo connection-test — pre-creation credential validation', () => {
  it('VALIDATES the correct account credentials and closes the throwaway worker', async () => {
    const h = build()
    const outcome = await h.provider.testSettings({
      settings: { email: 'a@b.com', password: GOOD_PASSWORD, region: 'us' },
    })
    expect(outcome.outcome).toBe('validated')
    expect(h.bridges[0]?.closed).toBe(true)
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
    expect(h.bridges[0]?.closed).toBe(true)
  })

  it('REJECTS an incomplete form without starting a worker', async () => {
    const h = build()
    const outcome = await h.provider.testSettings({ settings: { email: 'a@b.com' } })
    expect(outcome.outcome).toBe('rejected')
    expect(h.bridges).toHaveLength(0)
  })

  it('is INCONCLUSIVE — never rejected — when the cloud cannot be reached', async () => {
    const h = build('unreachable')
    const outcome = await h.provider.testSettings({
      settings: { email: 'a@b.com', password: GOOD_PASSWORD, region: 'us' },
    })
    // A transport fault says nothing about the credentials. Calling it a
    // rejection would block a good create whenever the network hiccups.
    expect(outcome.outcome).toBe('inconclusive')
    expect(h.bridges[0]?.closed).toBe(true)
  })

  it('is INCONCLUSIVE when the node has no Python to run the worker', async () => {
    const h = build('no-python')
    const outcome = await h.provider.testSettings({
      settings: { email: 'a@b.com', password: GOOD_PASSWORD, region: 'us' },
    })
    expect(outcome.outcome).toBe('inconclusive')
  })
})
