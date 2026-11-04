/**
 * Which HomeKit bridge identity the addon boots with: the default instance record, and nothing
 * else. There is no fallback to the settings the identity once lived in; the migration moved it.
 * A fresh identity is minted only when no record exists AND no legacy identity is still stored.
 * A legacy identity without a record means the migration did not finish, and minting then would
 * unpair every controller, so the addon refuses to boot with the reason.
 */
import { type HapBridgeBody, type HapBridgeIdentity, identityOfBody } from './hap-instance-kinds.js'

export type StoredBridge =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'resolved'; readonly body: HapBridgeBody }

export interface IdentityPorts {
  readRecord(): Promise<StoredBridge>
  /** Whether a complete identity is still stored in the old settings (the migration is unfinished). */
  legacyIdentityPresent(): Promise<boolean>
  /** Persist a new setup code on the existing record. */
  patchPincode(pincode: string): Promise<void>
  /** Create the record for a freshly minted identity. */
  putFresh(body: HapBridgeBody): Promise<void>
  mint(): HapBridgeBody
}

/** An operator-supplied `fixedPin` overrides the pincode, never the username/uuid. */
export async function resolveBridgeIdentity(
  fixedPin: string | null,
  ports: IdentityPorts,
): Promise<{ readonly identity: HapBridgeIdentity; readonly minted: boolean }> {
  const stored = await ports.readRecord()
  if (stored.kind === 'unavailable') {
    throw new Error('export-hap: the bridge identity exists but the keychain cannot serve it')
  }
  if (stored.kind === 'resolved') {
    if (fixedPin !== null && fixedPin !== stored.body.pincode) {
      await ports.patchPincode(fixedPin)
      return { identity: identityOfBody({ ...stored.body, pincode: fixedPin }), minted: false }
    }
    return { identity: identityOfBody(stored.body), minted: false }
  }
  if (await ports.legacyIdentityPresent()) {
    throw new Error(
      'export-hap: a bridge identity is still in the old settings but its instance record does not exist; the identity migration did not complete. Refusing to boot: a new identity would unpair every HomeKit controller',
    )
  }
  const fresh = ports.mint()
  const body = fixedPin === null ? fresh : { ...fresh, pincode: fixedPin }
  await ports.putFresh(body)
  return { identity: identityOfBody(body), minted: true }
}
