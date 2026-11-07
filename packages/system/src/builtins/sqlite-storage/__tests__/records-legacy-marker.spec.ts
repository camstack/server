/**
 * An operator write that SETS a secret over a row whose stored marker is not the row's own
 * ref (a row adopted from a settings array, or written under another owner/collection name).
 */
import {
  createRecordsAccess,
  createSecretsAccess,
  defineRecordKinds,
  recordSecretRef,
} from '@camstack/types'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { makeFakeKeychain, makeRecordsWorld } from './support/records-world.js'

const OWNER = 'auth-oidc'
const kinds = defineRecordKinds({
  'oidc-provider': {
    schema: z.object({
      displayName: z.string().min(1),
      clientSecret: z.string().meta({ secret: true }).optional(),
    }),
    class: 'config',
    writeTrigger: 'an operator edits a provider',
    retention: { none: 'config' },
  },
})

const LEGACY = [
  'secret://auth-oidc/global/providers[prod01].clientSecret',
  'secret://auth/row/records%3Aoidc-provider/prod01/clientSecret',
  'secret://auth-oidc/row/oidc-provider/prod01/clientSecret',
]

describe('a write that sets a secret over a legacy stored marker', () => {
  for (const legacy of LEGACY) {
    it(`replaces ${legacy}`, async () => {
      const world = makeRecordsWorld()
      const keychain = makeFakeKeychain()
      const records = createRecordsAccess({
        owner: OWNER,
        transport: world.transportFor(OWNER),
        secrets: createSecretsAccess({ owner: OWNER, transport: keychain }),
      })
      await records.declare(kinds)
      const kind = records.kind(kinds['oidc-provider'])
      await kind.put({
        id: 'prod01',
        data: { displayName: 'Prod', clientSecret: 'old' },
      })
      world.settings.db
        .prepare(
          `UPDATE records SET data = jsonb_set(data, '$.clientSecret', jsonb(?)) WHERE id = 'prod01'`,
        )
        .run(JSON.stringify({ $secret: legacy, v: 1 }))
      await kind.patch('prod01', {
        displayName: 'Prod 2',
        clientSecret: 'new-secret',
      })
      const own = recordSecretRef(OWNER, 'oidc-provider', 'prod01', 'clientSecret')
      expect(keychain.values.get(own)).toBe('new-secret')
      expect((await kind.getResolved('prod01'))?.data.clientSecret).toBe('new-secret')
    })
  }
})
