/**
 * The identity the bridge boots with. A paired controller knows the bridge by username, uuid, setup
 * code and pairing directory: they must come back byte-identical whether the identity sits in the
 * default instance record or still only in the legacy settings, and a bridge whose identity cannot
 * be READ must refuse to boot instead of minting a new one.
 */
import { describe, expect, it } from 'vitest'
import { type IdentityPorts, resolveBridgeIdentity, type StoredBridge } from '../hap-identity.js'
import type { HapBridgeBody } from '../hap-instance-kinds.js'

const PAIRED = {
  username: 'AA:BB:CC:11:22:33',
  uuid: '6f1d6c9e-0a52-5d0b-9d2e-0b1f3a9a7e44',
  pincode: '246-80-135',
}
const BODY: HapBridgeBody = {
  name: 'Home',
  ...PAIRED,
  persistDir: 'hap-store',
}
const FRESH: HapBridgeBody = {
  name: 'Home',
  username: '00:00:00:00:00:01',
  uuid: 'fresh-uuid',
  pincode: '135-79-246',
  persistDir: 'hap-store',
}

function ports(stored: StoredBridge, legacyPresent: boolean) {
  const calls: string[] = []
  const impl: IdentityPorts = {
    readRecord: async () => stored,
    legacyIdentityPresent: async () => legacyPresent,
    patchPincode: async (pin) => void calls.push(`patch:${pin}`),
    putFresh: async (body) => void calls.push(`put:${body.username}`),
    mint: () => FRESH,
  }
  return { impl, calls }
}

describe('resolveBridgeIdentity', () => {
  it('serves the record identity byte for byte', async () => {
    const { impl, calls } = ports({ kind: 'resolved', body: BODY }, false)
    const { identity, minted } = await resolveBridgeIdentity(null, impl)
    expect(identity).toEqual({ ...PAIRED, persistDir: 'hap-store' })
    expect(minted).toBe(false)
    expect(calls).toEqual([])
  })

  it('does not boot from a legacy identity: with no record it refuses, minting and writing nothing', async () => {
    const { impl, calls } = ports({ kind: 'absent' }, true)
    await expect(resolveBridgeIdentity(null, impl)).rejects.toThrow(/migration did not complete/)
    expect(calls).toEqual([])
  })

  it('a fixed pin changes the setup code only', async () => {
    const { impl, calls } = ports({ kind: 'resolved', body: BODY }, false)
    const { identity } = await resolveBridgeIdentity('111-22-333', impl)
    expect(identity).toEqual({
      ...PAIRED,
      pincode: '111-22-333',
      persistDir: 'hap-store',
    })
    expect(calls).toEqual(['patch:111-22-333'])
  })

  it('mints only when neither the record nor a legacy identity exists', async () => {
    const { impl, calls } = ports({ kind: 'absent' }, false)
    const { identity, minted } = await resolveBridgeIdentity(null, impl)
    expect(minted).toBe(true)
    expect(identity.username).toBe(FRESH.username)
    expect(calls).toEqual([`put:${FRESH.username}`])
  })

  it('refuses to mint over an identity the keychain cannot serve', async () => {
    const { impl, calls } = ports({ kind: 'unavailable' }, true)
    await expect(resolveBridgeIdentity(null, impl)).rejects.toThrow(/keychain cannot serve/)
    expect(calls).toEqual([])
  })
})
