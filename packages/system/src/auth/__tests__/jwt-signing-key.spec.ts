import type { KeychainResolveResult, SecretsAccess } from '@camstack/types'
import * as jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AuthConfigReader, AuthManager } from '../auth-manager.js'
import {
  clearProcessJwtSigningKey,
  getProcessJwtSigningKeyState,
  JWT_SIGNING_KEY_REF,
  JwtSigningKeyUnavailableError,
  loadJwtSigningKey,
  processJwtSigningKey,
  setProcessJwtSigningKey,
  staticJwtSigningKey,
} from '../jwt-signing-key.js'

/**
 * The session signing key lives in the keychain (owner `system`), never in
 * env or config.yaml. A locked keychain is NOT papered over: no env fallback,
 * no fresh random key that would silently log everyone out — sessions can be
 * neither minted nor verified until the keychain answers.
 */

function fakeSecrets(entry: KeychainResolveResult[string] | 'throw'): SecretsAccess & {
  readonly put: ReturnType<typeof vi.fn>
} {
  const put = vi.fn(async () => 1)
  const access = {
    owner: 'system',
    ref: () => JWT_SIGNING_KEY_REF,
    resolve: async (refs: readonly string[]) => {
      if (entry === 'throw') throw new Error('transport down')
      const out: KeychainResolveResult = {}
      for (const ref of refs) out[ref] = entry
      return out
    },
    put,
    delete: async () => 0,
    state: async () => ({ state: 'ready' as const }),
    onChange: () => () => undefined,
    forOwner: null,
  }
  return access
}

afterEach(() => clearProcessJwtSigningKey())

describe('loadJwtSigningKey', () => {
  it('uses the stored key', async () => {
    const secrets = fakeSecrets({ kind: 'value', value: 'stored-key', version: 3 })
    const state = await loadJwtSigningKey({ secrets, generate: () => 'never' })
    expect(state).toEqual({ state: 'ready', key: 'stored-key' })
    expect(secrets.put).not.toHaveBeenCalled()
  })

  it('generates and stores a key only when the keychain answers "missing"', async () => {
    const secrets = fakeSecrets({ kind: 'missing' })
    const state = await loadJwtSigningKey({ secrets, generate: () => 'fresh-key' })
    expect(state).toEqual({ state: 'ready', key: 'fresh-key' })
    expect(secrets.put).toHaveBeenCalledWith(JWT_SIGNING_KEY_REF, 'fresh-key')
  })

  it('never generates while the keychain is locked', async () => {
    const secrets = fakeSecrets({ kind: 'unavailable', reason: 'wrong-key' })
    const state = await loadJwtSigningKey({ secrets, generate: () => 'fresh-key' })
    expect(state).toEqual({ state: 'unavailable', reason: 'wrong-key' })
    expect(secrets.put).not.toHaveBeenCalled()
  })

  it('reports a failed store of a generated key as unavailable, not ready', async () => {
    const secrets = fakeSecrets({ kind: 'missing' })
    secrets.put.mockRejectedValueOnce(new Error('keychain locked'))
    const state = await loadJwtSigningKey({ secrets, generate: () => 'fresh-key' })
    expect(state.state).toBe('unavailable')
  })

  it('reads a forbidden answer as unavailable', async () => {
    const secrets = fakeSecrets({ kind: 'forbidden' })
    expect((await loadJwtSigningKey({ secrets, generate: () => 'x' })).state).toBe('unavailable')
  })

  it('the ref is the system-owned global one', () => {
    expect(JWT_SIGNING_KEY_REF).toBe('secret://system/global/jwtSigningKey')
  })
})

describe('the process signing key', () => {
  it('is unavailable until the hub loaded it', () => {
    expect(getProcessJwtSigningKeyState().state).toBe('unavailable')
    expect(() => processJwtSigningKey.current()).toThrow(JwtSigningKeyUnavailableError)
  })

  it('answers the loaded key', () => {
    setProcessJwtSigningKey({ state: 'ready', key: 'k1' })
    expect(processJwtSigningKey.current()).toBe('k1')
  })
})

describe('AuthManager over a signing key source', () => {
  const config = { get: () => undefined, update: () => undefined }
  const payload = {
    userId: 'u',
    username: 'u',
    isAdmin: true,
    allowedProviders: '*' as const,
    allowedDevices: {},
  }

  it('signs and verifies with the source key — never a config value', () => {
    const auth = new AuthManager(config, undefined, staticJwtSigningKey('the-key'))
    const token = auth.signToken(payload)
    expect(() => jwt.verify(token, 'the-key')).not.toThrow()
    expect(auth.verifyToken(token).userId).toBe('u')
  })

  it('refuses to mint or verify while the key is unavailable', () => {
    const auth = new AuthManager(config)
    expect(() => auth.signToken(payload)).toThrow(JwtSigningKeyUnavailableError)
    const foreign = jwt.sign(payload, 'whatever')
    expect(() => auth.verifyToken(foreign)).toThrow(JwtSigningKeyUnavailableError)
  })

  it('follows the process key once it is loaded (no restart of the manager)', () => {
    const auth = new AuthManager(config)
    setProcessJwtSigningKey({ state: 'ready', key: 'late-key' })
    const token = auth.signToken(payload)
    expect(() => jwt.verify(token, 'late-key')).not.toThrow()
  })

  it('never writes a generated secret into config', () => {
    const update = vi.fn()
    const reader: AuthConfigReader = { get: () => undefined, update }
    const manager = new AuthManager(reader)
    expect(manager).toBeInstanceOf(AuthManager)
    expect(update).not.toHaveBeenCalled()
  })
})
