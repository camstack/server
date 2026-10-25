/**
 * D878 - the Secrets page must call a profile's apiKey and a TOTP seed IN USE
 * while their row points at them (deleting "orphans" would delete a user's 2FA),
 * and an orphan once the row is gone.
 */
import { buildSecretRef, makeSecretMarker } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createKeychainUsageCheck } from '../keychain-usage.js'
import { MemoryDoor } from './memory-door.js'

const PROFILE_REF = buildSecretRef({
  owner: 'ai',
  scope: { kind: 'row', collection: 'ai:llm-profiles', rowId: 'p1' },
  fieldPath: 'apiKey',
})
const TOTP_REF = buildSecretRef({
  owner: 'system',
  scope: { kind: 'row', collection: 'user_totp', rowId: 'u1' },
  fieldPath: 'secret',
})

function row(ref: string) {
  return { ref, scope: 'row', owner: ref.includes('//ai/') ? 'ai' : 'system' } as never
}

describe('usage of keychain-backed rows', () => {
  it('in use while the row holds the marker (object in a KV blob, JSON text in a typed column)', async () => {
    const door = new MemoryDoor()
    await door.set({
      collection: 'ai:llm-profiles',
      key: 'p1',
      value: { apiKey: makeSecretMarker(PROFILE_REF) },
    })
    await door.set({
      collection: 'user_totp',
      key: 'u1',
      value: { userId: 'u1', secret: JSON.stringify(makeSecretMarker(TOTP_REF)) },
    })
    const usage = await createKeychainUsageCheck(door)([row(PROFILE_REF), row(TOTP_REF)])
    expect(usage.get(PROFILE_REF)).toBe('in-use')
    expect(usage.get(TOTP_REF)).toBe('in-use')
  })

  it('orphan once the row is gone', async () => {
    const door = new MemoryDoor()
    const usage = await createKeychainUsageCheck(door)([row(PROFILE_REF), row(TOTP_REF)])
    expect(usage.get(PROFILE_REF)).toBe('orphan')
    expect(usage.get(TOTP_REF)).toBe('orphan')
  })
})
