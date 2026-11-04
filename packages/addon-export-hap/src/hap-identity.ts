/**
 * Which HomeKit bridge identity the addon boots with. The default instance record is the
 * authority; a complete legacy `identity` (the migration has not run yet) is used as it is; only
 * when neither exists is a fresh one minted. Minting over an identity that exists but cannot be
 * read is the one mistake that matters: a new identity unpairs every controller.
 */
import {
  type HapBridgeBody,
  type HapBridgeIdentity,
  HAP_DEFAULT_PERSIST_DIR,
  identityOfBody,
} from './hap-instance-kinds.js'

export type StoredBridge =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'resolved'; readonly body: HapBridgeBody }

export interface IdentityPorts {
  readRecord(): Promise<StoredBridge>
  readLegacy(): Promise<Omit<HapBridgeIdentity, 'persistDir'> | null>
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
      return {
        identity: identityOfBody({ ...stored.body, pincode: fixedPin }),
        minted: false,
      }
    }
    return { identity: identityOfBody(stored.body), minted: false }
  }
  const legacy = await ports.readLegacy()
  if (legacy !== null) {
    return {
      identity: {
        ...legacy,
        pincode: fixedPin ?? legacy.pincode,
        persistDir: HAP_DEFAULT_PERSIST_DIR,
      },
      minted: false,
    }
  }
  const fresh = ports.mint()
  const body = fixedPin === null ? fresh : { ...fresh, pincode: fixedPin }
  await ports.putFresh(body)
  return { identity: identityOfBody(body), minted: true }
}
