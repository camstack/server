import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { PasskeyStore } from '../passkey-store.js'
import { authWebauthnRecordKinds } from '../record-kinds.js'

describe('PasskeyStore — records path', () => {
  it('insert/find/update without legacy collections', async () => {
    const world = makeInMemoryRecords('auth-webauthn')
    await world.records.declare(authWebauthnRecordKinds)
    const records = world.records
    const store = new PasskeyStore({
      passkeysKind: records.kind(authWebauthnRecordKinds.passkeys),
      prefsKind: records.kind(authWebauthnRecordKinds['passkey-prefs']),
    })
    await store.insert({
      credentialId: 'cred-1',
      userId: 'u1',
      publicKey: 'pk',
      counter: 0,
      transports: [],
      label: 'Yubi',
      createdAt: 1,
      lastUsedAt: null,
    })
    const found = await store.findByCredentialId('cred-1')
    expect(found?.userId).toBe('u1')
    await store.updateCounter('cred-1', 3)
    expect((await store.findByCredentialId('cred-1'))?.counter).toBe(3)
    await store.setSecondFactorPreference('u1', true)
    expect(await store.getSecondFactorPreference('u1')).toBe(true)
  })
})
