/** A complete in-memory keychain handle for owner `system`. Test-only. */
import type { SecretsAccess } from '@camstack/types'

export interface FakeSecrets {
  readonly handle: SecretsAccess
  readonly values: Map<string, string>
  /** Make the next `put` throw (a keychain that locks mid-creation). */
  failNextPut(): void
  puts(): number
}

export function makeFakeSecrets(): FakeSecrets {
  const values = new Map<string, string>()
  let failPut = false
  let putCount = 0
  const handle = {
    owner: 'system',
    ref: () => 'unused',
    resolve: async (refs: readonly string[]) =>
      Object.fromEntries(
        refs.map((ref) => {
          const value = values.get(ref)
          return [
            ref,
            value === undefined ? { kind: 'missing' } : { kind: 'value', value, version: 1 },
          ]
        }),
      ),
    put: async (ref: string, value: string) => {
      if (failPut) {
        failPut = false
        throw new Error('keychain locked')
      }
      putCount += 1
      values.set(ref, value)
      return 1
    },
    delete: async () => 0,
    state: async () => ({ state: 'ready' }),
    onChange: () => () => undefined,
    forOwner: null,
  }
  return {
    handle: handle as unknown as SecretsAccess,
    values,
    failNextPut: () => {
      failPut = true
    },
    puts: () => putCount,
  }
}

export function fakeSecrets(): SecretsAccess {
  return makeFakeSecrets().handle
}
