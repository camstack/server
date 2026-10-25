/**
 * Test kit for device certificates: an in-memory keychain handle and a
 * "device" that owns a P-256 key and signs like the viewer will (raw r||s).
 */
import { webcrypto } from 'node:crypto'
import type { SecretsAccess } from '@camstack/types'

export function fakeSecrets(): SecretsAccess {
  const values = new Map<string, string>()
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
      values.set(ref, value)
      return 1
    },
    delete: async () => 0,
    state: async () => ({ state: 'ready' }),
    onChange: () => () => undefined,
    forOwner: null,
  }
  return handle as unknown as SecretsAccess
}

export interface TestDevice {
  /** SubjectPublicKeyInfo DER, base64url. */
  readonly spki: string
  sign(message: string): Promise<string>
}

export async function newTestDevice(): Promise<TestDevice> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString(
    'base64url',
  )
  return {
    spki,
    sign: async (message) =>
      Buffer.from(
        await webcrypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          Buffer.from(message),
        ),
      ).toString('base64url'),
  }
}
