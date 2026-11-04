/**
 * Whether the DEFAULT HomeKit bridge exists at boot, and with which identity: the default instance
 * record, and nothing else. There is no fallback to the settings the identity once lived in; the
 * migration moved it. A fresh default identity is minted only when no default record exists, no
 * other bridge exists (the operator may have deleted the default one on purpose) AND no legacy
 * identity is still stored. A legacy identity without a record means the migration did not finish,
 * and minting then would unpair every controller, so the addon refuses to boot with the reason.
 *
 * Every other instance is read as it is stored; this module is only about the default one.
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
  /** Whether any bridge record exists beside the default one. */
  otherBridgesExist(): Promise<boolean>
  /** Create the record for a freshly minted identity. */
  putFresh(body: HapBridgeBody): Promise<void>
  mint(): HapBridgeBody
}

export type BootIdentity =
  | { readonly kind: 'existing'; readonly identity: HapBridgeIdentity }
  | { readonly kind: 'minted'; readonly identity: HapBridgeIdentity }
  /** The default bridge was deleted and others remain: nothing to boot under its id. */
  | { readonly kind: 'none' }

export async function resolveDefaultBridge(ports: IdentityPorts): Promise<BootIdentity> {
  const stored = await ports.readRecord()
  if (stored.kind === 'unavailable') {
    throw new Error('export-hap: the bridge identity exists but the keychain cannot serve it')
  }
  if (stored.kind === 'resolved') {
    return { kind: 'existing', identity: identityOfBody(stored.body) }
  }
  if (await ports.legacyIdentityPresent()) {
    throw new Error(
      'export-hap: a bridge identity is still in the old settings but its instance record does not exist; the identity migration did not complete. Refusing to boot: a new identity would unpair every HomeKit controller',
    )
  }
  if (await ports.otherBridgesExist()) return { kind: 'none' }
  const body = ports.mint()
  await ports.putFresh(body)
  return { kind: 'minted', identity: identityOfBody(body) }
}
