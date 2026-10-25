import { describe, expect, it } from 'vitest'
import type { KeychainResolveResult } from '../../capabilities/keychain.cap.js'
import { resolveSecretViewsIn } from '../resolve-secret-views.js'
import { SECRET_CLEAR } from '../secret-marker.js'
import { createSecretsAccess } from '../secrets-access.js'

const MINE = 'secret://cloudflare-tunnel/global/customApiToken'
const THEIRS = 'secret://auth-oidc/global/providers[x].clientSecret'

const secrets = createSecretsAccess({
  owner: 'cloudflare-tunnel',
  transport: {
    put: async ({ ref }) => ({ ref, version: 1 }),
    resolve: async ({ refs }) => {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        out[ref] =
          ref === MINE
            ? { kind: 'value', value: 'stored-api-token-value', version: 1 }
            : { kind: 'forbidden' }
      }
      return out
    },
    delete: async () => ({ deleted: 0 }),
    getState: async () => ({ state: 'ready' }),
  },
})

describe('an action input carrying secret views (D789)', () => {
  it('resolves the owner’s own view to its value', async () => {
    expect(
      await resolveSecretViewsIn({ token: { $secret: MINE, v: 1, set: true }, other: 1 }, secrets),
    ).toEqual({ token: 'stored-api-token-value', other: 1 })
  })

  it('drops what it cannot resolve: another owner’s ref, an inline view, a clear', async () => {
    expect(
      await resolveSecretViewsIn(
        {
          a: { $secret: THEIRS, v: 1, set: true },
          b: { $secret: null, v: 1, set: true, inline: true },
          c: SECRET_CLEAR,
          d: 'kept',
        },
        secrets,
      ),
    ).toEqual({ d: 'kept' })
  })

  it('an input with no view is returned as-is', async () => {
    const input = { token: 'typed-token-value' }
    expect(await resolveSecretViewsIn(input, secrets)).toBe(input)
  })
})
