import { makeInMemoryRecords, type RecordsAccess } from '@camstack/types'
import { authWebauthnRecordKinds } from '../record-kinds.js'
import { PasskeyStore, type StoredPasskey } from '../passkey-store.js'

/** In-memory records world matching production webauthn boot (phase 6). */
export async function makeWebauthnTestRecords(): Promise<RecordsAccess> {
  const world = makeInMemoryRecords('auth-webauthn')
  await world.records.declare(authWebauthnRecordKinds)
  return world.records
}

function passkeyStoreFor(records: RecordsAccess): PasskeyStore {
  return new PasskeyStore({
    passkeysKind: records.kind(authWebauthnRecordKinds.passkeys),
    prefsKind: records.kind(authWebauthnRecordKinds['passkey-prefs']),
  })
}

/** Seed a credential the way production `PasskeyStore.insert` persists it. */
export async function seedTestPasskey(
  records: RecordsAccess,
  overrides: Partial<StoredPasskey> = {},
): Promise<void> {
  const base: StoredPasskey = {
    credentialId: 'cred-1',
    userId: 'u-1',
    publicKey: Buffer.from('pubkey-bytes').toString('base64url'),
    counter: 5,
    transports: ['internal'],
    label: 'MacBook Touch ID',
    createdAt: 1_000,
    lastUsedAt: null,
  }
  await passkeyStoreFor(records).insert({ ...base, ...overrides })
}

export async function passkeyCounter(
  records: RecordsAccess,
  credentialId: string,
): Promise<number> {
  const found = await passkeyStoreFor(records).findByCredentialId(credentialId)
  if (found === null) throw new Error(`passkey ${credentialId} missing in records`)
  return found.counter
}
