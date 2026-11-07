/**
 * A stored foreign marker is replaced by the row's own ref on a secret write. A defensive
 * pin: the adoption path that produced such rows is closed (ADR-0900), but leftover markers
 * from an old auth-oidc providers array still exist on the hub (ADR-0979).
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

const FOREIGN_MARKER = [
  'secret://auth-oidc/global/providers[prod01].clientSecret',
  'secret://auth/row/records%3Aoidc-provider/prod01/clientSecret',
  'secret://auth-oidc/row/oidc-provider/prod01/clientSecret',
]

describe('a secret write over a stored foreign marker', () => {
  for (const foreign of FOREIGN_MARKER) {
    it(`replaces ${foreign}`, async () => {
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
        .run(JSON.stringify({ $secret: foreign, v: 1 }))
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
