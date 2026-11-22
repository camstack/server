import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { KiaConfig } from '../config.js'
import { KiaBridgeError } from '../kia-bridge.js'
import { buildKiaConnectionTestProvider } from '../kia-connection-test.js'
import { buildKiaInstances, kiaConnectionsEntryKind, kiaRecordKinds } from '../kia-instances.js'
import { FakeBridge } from './fake-bridge.js'

/**
 * The fake behaves like the real cloud: exactly ONE password and ONE PIN are accepted, and a
 * wrong one comes back as the worker's `auth` code. A fake that always resolved would make the
 * gate look correct while gating on nothing.
 */
const GOOD_PASSWORD = 'the-real-password'
const GOOD_PIN = '4321'
const GOOD = {
  username: 'a@b.com',
  password: GOOD_PASSWORD,
  pin: GOOD_PIN,
  region: 'europe',
  brand: 'kia',
} as const

type Mode = 'cloud' | 'unreachable' | 'otp' | 'no-python'

function build(mode: Mode = 'cloud') {
  const clock = { now: 1_795_000_000_000 }
  const bridges: FakeBridge[] = []
  const seen: KiaConfig[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const provider = buildKiaConnectionTestProvider({
    makeBridge: () => {
      if (mode === 'no-python') throw new Error('Kia needs the embedded Python')
      const bridge = new FakeBridge()
      const login = bridge.login.bind(bridge)
      bridge.login = async (config: KiaConfig) => {
        seen.push(config)
        if (mode === 'unreachable') throw new KiaBridgeError('unreachable', 'getaddrinfo ENOTFOUND')
        if (mode === 'otp') throw new KiaBridgeError('otp-required', 'code needed')
        if (config.password !== GOOD_PASSWORD || config.pin !== GOOD_PIN) {
          throw new KiaBridgeError('auth', 'refused')
        }
        return login(config)
      }
      bridges.push(bridge)
      return bridge
    },
    logger: logger as never,
    now: () => clock.now,
  })
  return { provider, bridges, seen, logger, clock }
}

describe('Kia connection-test: pre-creation credential validation', () => {
  it('VALIDATES the correct credentials and closes the throwaway worker', async () => {
    const h = build()
    const outcome = await h.provider.testSettings({ settings: GOOD })
    expect(outcome.outcome).toBe('validated')
    expect(h.bridges[0]?.closed).toBe(true)
  })

  it('REJECTS a wrong password or a wrong PIN, and never echoes either back', async () => {
    for (const settings of [
      { ...GOOD, password: 'wrong-pw' },
      { ...GOOD, pin: '0000' },
    ]) {
      const h = build()
      const outcome = await h.provider.testSettings({ settings })
      expect(outcome.outcome).toBe('rejected')
      if (outcome.outcome !== 'rejected') throw new Error('unreachable')
      expect(outcome.error).toMatch(/refused these credentials/)
      expect(outcome.error).not.toContain('wrong-pw')
      expect(outcome.error).not.toContain('0000')
      expect(h.bridges[0]?.closed).toBe(true)
    }
  })

  it('REJECTS an incomplete form without starting a worker', async () => {
    const h = build()
    const outcome = await h.provider.testSettings({
      settings: { username: 'a@b.com', password: 'x' },
    })
    expect(outcome.outcome).toBe('rejected')
    expect(h.bridges).toHaveLength(0)
  })

  it('REJECTS an account that asks for a one-time code: this integration cannot answer it', async () => {
    const outcome = await build('otp').provider.testSettings({ settings: GOOD })
    expect(outcome.outcome).toBe('rejected')
  })

  it('is INCONCLUSIVE, never rejected, when the cloud cannot be reached or there is no Python', async () => {
    for (const mode of ['unreachable', 'no-python'] as const) {
      const outcome = await build(mode).provider.testSettings({ settings: GOOD })
      expect(outcome.outcome).toBe('inconclusive')
    }
  })
})

describe('Kia instance Test action', () => {
  async function instancesWorld() {
    const mem = makeInMemoryRecords('provider-kia')
    await mem.records.declare(kiaRecordKinds)
    const h = build()
    const instances = buildKiaInstances(mem.records, {
      onChanged: async () => undefined,
      tester: h.provider,
    })
    const seed = async (body: Record<string, unknown>) =>
      mem.records
        .kind(kiaConnectionsEntryKind)
        .put({ id: 'int_1', data: { name: 'Car', ...body } }, { ifRev: 0 })
    return { instances, seed, ...h }
  }

  it('offers the Test action', async () => {
    const { instances } = await instancesWorld()
    expect((await instances.describe()).canTest).toBe(true)
  })

  it('signs in with the STORED password and PIN when the form hands back its redacted view', async () => {
    const { instances, seen, seed } = await instancesWorld()
    await seed({
      username: 'a@b.com',
      password: GOOD_PASSWORD,
      pin: GOOD_PIN,
      region: 'europe',
      brand: 'kia',
    })
    const result = await instances.testInstance({
      id: 'int_1',
      values: {
        username: 'a@b.com',
        password: REDACTED_SECRET,
        pin: REDACTED_SECRET,
        region: 'europe',
        brand: 'kia',
      },
    })
    expect(result.success).toBe(true)
    expect(seen.at(-1)).toMatchObject({ password: GOOD_PASSWORD, pin: GOOD_PIN })
  })

  it('uses a retyped PIN and reports a refusal', async () => {
    const { instances, seen, seed } = await instancesWorld()
    await seed({
      username: 'a@b.com',
      password: GOOD_PASSWORD,
      pin: GOOD_PIN,
      region: 'europe',
      brand: 'kia',
    })
    const result = await instances.testInstance({
      id: 'int_1',
      values: {
        username: 'a@b.com',
        password: REDACTED_SECRET,
        pin: '9999',
        region: 'europe',
        brand: 'kia',
      },
    })
    expect(result.success).toBe(false)
    expect(seen.at(-1)).toMatchObject({ pin: '9999', password: GOOD_PASSWORD })
  })

  it('keeps the password and the PIN out of the record data: the keychain holds them', async () => {
    const mem = makeInMemoryRecords('provider-kia')
    await mem.records.declare(kiaRecordKinds)
    const instances = buildKiaInstances(mem.records, {
      onChanged: async () => undefined,
      tester: { testSettings: async () => ({ outcome: 'validated' }) },
    })
    await mem.records.kind(kiaConnectionsEntryKind).put(
      {
        id: 'int_2',
        data: {
          name: 'Car',
          username: 'a@b.com',
          password: 'pw-secret-xyz',
          pin: '5555',
          region: 'europe',
          brand: 'kia',
        },
      },
      { ifRev: 0 },
    )
    const stored = JSON.stringify(mem.tables.get('connections')?.get('int_2')?.data)
    expect(stored).not.toContain('pw-secret-xyz')
    expect(stored).not.toContain('5555')
    const read = await instances.readResolved('int_2')
    expect(read?.body).toMatchObject({ password: 'pw-secret-xyz', pin: '5555' })
  })
})

describe('Kia connection-test: it must not hammer the account', () => {
  it('refuses a second sign-in for the same account within a minute, and signs in again after', async () => {
    const h = build()
    await h.provider.testSettings({ settings: GOOD })
    const again = await h.provider.testSettings({ settings: GOOD })
    expect(again.outcome).toBe('inconclusive')
    expect(h.seen).toHaveLength(1)
    h.clock.now += 61_000
    expect((await h.provider.testSettings({ settings: GOOD })).outcome).toBe('validated')
    expect(h.seen).toHaveLength(2)
  })

  it('does not repeat a refused sign-in with the same credentials, but accepts changed ones', async () => {
    const h = build()
    const wrong = { ...GOOD, password: 'wrong-pw' }
    expect((await h.provider.testSettings({ settings: wrong })).outcome).toBe('rejected')
    h.clock.now += 61_000
    const repeat = await h.provider.testSettings({ settings: wrong })
    expect(repeat.outcome).toBe('rejected')
    expect(h.seen).toHaveLength(1)
    expect((await h.provider.testSettings({ settings: GOOD })).outcome).toBe('validated')
  })
})
