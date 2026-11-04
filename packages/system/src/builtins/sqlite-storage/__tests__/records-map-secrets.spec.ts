/**
 * A secret held in a MAP of the body (`applianceSecrets: { [id]: secret }`, planning#416):
 * `z.record(z.string(), z.string().meta({ secret: true }))` declares the path `applianceSecrets{}`,
 * every value is a keychain marker bound to the row under its own key, and the keys stay in the
 * row. Real SQLite engine, fake keychain.
 */
import {
  collectZodSecretPaths,
  createRecordsAccess,
  createSecretsAccess,
  defineRecordKinds,
  recordSecretRef,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeFakeKeychain, makeRecordsWorld } from './support/records-world.js'

const OWNER = 'bosch-spec'
const kinds = defineRecordKinds({
  account: {
    schema: z.object({
      name: z.string().min(1),
      password: z.string().meta({ secret: true }).optional(),
      applianceSecrets: z.record(z.string(), z.string().meta({ secret: true })).optional(),
    }),
    class: 'config',
    writeTrigger: 'an operator saves an account',
    retention: { none: 'config' },
  },
})

function setup() {
  const world = makeRecordsWorld()
  const keychain = makeFakeKeychain()
  const records = createRecordsAccess({
    owner: OWNER,
    transport: world.transportFor(OWNER),
    secrets: createSecretsAccess({ owner: OWNER, transport: keychain }),
    logger: { warn: () => undefined },
  })
  return { world, keychain, records }
}

describe('a secret inside a map of the body', () => {
  it('declares the path with the map marker', () => {
    expect(collectZodSecretPaths(kinds.account.schema)).toEqual(['password', 'applianceSecrets{}'])
  })

  it('stores a marker per key, never the value, and resolves each back', async () => {
    const { world, keychain, records } = setup()
    await records.declare(kinds)
    const account = records.kind(kinds.account)
    await account.put({
      id: 'a1',
      data: { name: 'A', applianceSecrets: { 'fridge/1': 'k-fridge', oven: 'k-oven' } },
    })
    const ref = recordSecretRef(
      OWNER,
      'account',
      'a1',
      `applianceSecrets{${encodeURIComponent('fridge/1')}}`,
    )
    expect(keychain.values.get(ref)).toBe('k-fridge')
    const stored = JSON.stringify(
      world.settings.db.prepare('SELECT json(data) AS d FROM records').all(),
    )
    expect(stored).not.toContain('k-fridge')
    expect(stored).not.toContain('k-oven')
    const resolved = await account.getResolved('a1')
    expect(resolved?.data.applianceSecrets).toEqual({ 'fridge/1': 'k-fridge', oven: 'k-oven' })
  })

  it('a patch that drops one key releases only that key; delete releases the rest', async () => {
    const { keychain, records } = setup()
    await records.declare(kinds)
    const account = records.kind(kinds.account)
    await account.put({
      id: 'a1',
      data: { name: 'A', applianceSecrets: { one: 'v1', two: 'v2' } },
    })
    await account.patch('a1', { applianceSecrets: { one: null } })
    const refOne = recordSecretRef(OWNER, 'account', 'a1', 'applianceSecrets{one}')
    const refTwo = recordSecretRef(OWNER, 'account', 'a1', 'applianceSecrets{two}')
    expect(keychain.values.has(refOne)).toBe(false)
    expect(keychain.values.get(refTwo)).toBe('v2')
    await account.delete('a1')
    expect(keychain.values.size).toBe(0)
  })
})
