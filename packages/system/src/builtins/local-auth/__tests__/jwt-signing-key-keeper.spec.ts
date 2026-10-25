import type { KeychainResolveEntry, SecretsAccess } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearProcessJwtSigningKey,
  getProcessJwtSigningKeyState,
  JWT_SIGNING_KEY_REF,
} from '../../../auth/jwt-signing-key.js'
import { JwtSigningKeyKeeper } from '../jwt-signing-key-keeper.js'

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** A keychain handle whose answer the test changes between calls. */
function scriptedSecrets(initial: KeychainResolveEntry) {
  let answer = initial
  const handlers = new Set<(ref: string) => void>()
  const put = vi.fn(async () => 1)
  const access: SecretsAccess = {
    owner: 'system',
    ref: () => JWT_SIGNING_KEY_REF,
    resolve: async (refs) => Object.fromEntries(refs.map((r) => [r, answer])),
    put,
    delete: async () => 0,
    state: async () => ({ state: 'ready' }),
    onChange: (h) => {
      handlers.add(h)
      return () => handlers.delete(h)
    },
    forOwner: null,
  }
  return {
    access,
    put,
    set: (next: KeychainResolveEntry) => {
      answer = next
    },
    fire: () => {
      for (const h of handlers) h(JWT_SIGNING_KEY_REF)
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  clearProcessJwtSigningKey()
})

describe('JwtSigningKeyKeeper', () => {
  it('registers the stored key at start', async () => {
    const s = scriptedSecrets({ kind: 'value', value: 'k', version: 1 })
    const keeper = new JwtSigningKeyKeeper({ secrets: s.access, logger: logger() })
    await keeper.start()
    expect(getProcessJwtSigningKeyState()).toEqual({ state: 'ready', key: 'k' })
    keeper.stop()
  })

  it('a locked keychain leaves sessions unavailable, logs an error, and retries — never generating', async () => {
    const s = scriptedSecrets({ kind: 'unavailable', reason: 'key-missing' })
    const log = logger()
    const keeper = new JwtSigningKeyKeeper({ secrets: s.access, logger: log, retryMs: 1000 })
    await keeper.start()
    expect(getProcessJwtSigningKeyState()).toEqual({ state: 'unavailable', reason: 'key-missing' })
    expect(log.error).toHaveBeenCalled()
    expect(s.put).not.toHaveBeenCalled()

    s.set({ kind: 'value', value: 'after-unlock', version: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(getProcessJwtSigningKeyState()).toEqual({ state: 'ready', key: 'after-unlock' })
    keeper.stop()
  })

  it('reloads when the stored key changes', async () => {
    const s = scriptedSecrets({ kind: 'value', value: 'old', version: 1 })
    const keeper = new JwtSigningKeyKeeper({ secrets: s.access, logger: logger() })
    await keeper.start()
    s.set({ kind: 'value', value: 'imported', version: 2 })
    s.fire()
    await vi.advanceTimersByTimeAsync(0)
    expect(getProcessJwtSigningKeyState()).toEqual({ state: 'ready', key: 'imported' })
    keeper.stop()
  })

  it('keeps a working key when a reload cannot read the keychain', async () => {
    const s = scriptedSecrets({ kind: 'value', value: 'good', version: 1 })
    const keeper = new JwtSigningKeyKeeper({ secrets: s.access, logger: logger() })
    await keeper.start()
    s.set({ kind: 'unavailable', reason: 'store-unavailable' })
    s.fire()
    await vi.advanceTimersByTimeAsync(0)
    expect(getProcessJwtSigningKeyState()).toEqual({ state: 'ready', key: 'good' })
    keeper.stop()
  })

  it('without a keychain door (not a hub), sessions stay unavailable', async () => {
    const log = logger()
    const keeper = new JwtSigningKeyKeeper({ secrets: null, logger: log })
    await keeper.start()
    expect(getProcessJwtSigningKeyState().state).toBe('unavailable')
    expect(log.error).toHaveBeenCalled()
    keeper.stop()
  })
})
