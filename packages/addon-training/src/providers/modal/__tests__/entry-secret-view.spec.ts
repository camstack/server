import { describe, expect, it } from 'vitest'
import {
  arrayItemFieldPath,
  buildSecretRef,
  createSecretsAccess,
  globalSecretScope,
  makeSecretMarker,
  type KeychainResolveResult,
} from '@camstack/types'
import { entryTokenSecretView, flatTokenSecretView } from '../entry-secret-view.js'

const OWNER = 'training-modal'

function secretsAccess() {
  return createSecretsAccess({
    owner: OWNER,
    transport: {
      put: async ({ ref }) => ({ ref, version: 1 }),
      resolve: async ({ refs }) => {
        const out: KeychainResolveResult = {}
        for (const ref of refs) out[ref] = { kind: 'missing' }
        return out
      },
      delete: async () => ({ deleted: 0 }),
      getState: async () => ({ state: 'ready' }),
    },
  })
}

describe('entryTokenSecretView', () => {
  it('returns null when the secret is empty', () => {
    expect(entryTokenSecretView('', secretsAccess(), 'e-1')).toBeNull()
    expect(entryTokenSecretView(undefined, secretsAccess(), 'e-1')).toBeNull()
  })

  it('passes a stored marker through as a set view', () => {
    const ref = buildSecretRef({
      owner: OWNER,
      scope: globalSecretScope(),
      fieldPath: arrayItemFieldPath('entries', 'e-1', 'tokenSecret'),
    })
    expect(entryTokenSecretView(makeSecretMarker(ref), secretsAccess(), 'e-1')).toEqual({
      $secret: ref,
      v: 1,
      set: true,
    })
  })

  it('builds a revealable keychain ref from resolved plaintext', () => {
    const secrets = secretsAccess()
    const view = entryTokenSecretView('as-live-secret', secrets, 'e-42')
    expect(view).toEqual({
      $secret: secrets.ref(
        globalSecretScope(),
        arrayItemFieldPath('entries', 'e-42', 'tokenSecret'),
      ),
      v: 1,
      set: true,
    })
    expect(view?.$secret).toContain('entries[e-42].tokenSecret')
  })

  it('falls back to an inline view when there is no secrets handle', () => {
    expect(entryTokenSecretView('as-inline', undefined, 'e-1')).toEqual({
      $secret: null,
      v: 1,
      set: true,
      inline: true,
    })
  })
})

describe('flatTokenSecretView', () => {
  it('builds the legacy flat ref', () => {
    const secrets = secretsAccess()
    expect(flatTokenSecretView('as-legacy', secrets)).toEqual({
      $secret: secrets.ref(globalSecretScope(), 'tokenSecret'),
      v: 1,
      set: true,
    })
  })
})
