/**
 * In-memory keychain for records secret fields in HA specs.
 */
import {
  buildSecretRef,
  type KeychainResolveResult,
  type SecretScope,
  type SecretsAccess,
} from '@camstack/types'

export interface FakeKeychain {
  readonly access: SecretsAccess
  readonly values: Map<string, string>
  setLocked(locked: boolean): void
}

export function makeFakeKeychain(owner = 'provider-homeassistant'): FakeKeychain {
  const values = new Map<string, string>()
  let locked = false
  const access: SecretsAccess = {
    owner,
    ref: (scope: SecretScope, fieldPath: string) => buildSecretRef({ owner, scope, fieldPath }),
    resolve: async (refs) => {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const value = values.get(ref)
        out[ref] = locked
          ? { kind: 'unavailable', reason: 'key-missing' }
          : value === undefined
            ? { kind: 'missing' }
            : { kind: 'value', value, version: 1 }
      }
      return out
    },
    put: async (ref, value) => {
      if (locked) throw new Error('keychain locked')
      values.set(ref, value)
      return 1
    },
    delete: async (refs) => {
      let deleted = 0
      for (const ref of refs) if (values.delete(ref)) deleted += 1
      return deleted
    },
    state: async () => (locked ? { state: 'locked', reason: 'key-missing' } : { state: 'ready' }),
    onChange: () => () => undefined,
    forOwner: null,
  }
  return {
    access,
    values,
    setLocked: (next) => {
      locked = next
    },
  }
}
