/**
 * The bridge identity the addon kept in its settings (`identity`: username, uuid, pincode) moves
 * into the default instance record (D985, D996). Paired controllers know the bridge by exactly
 * these values, so the record is created with them UNCHANGED and the pass proves it by reading the
 * record back and comparing, field by field, before it reports `done`.
 *
 * Only once the read-back matches is the old `identity` cleared (its keychain entry released with
 * it), in this same pass: one path, no copy. An existing record is never overwritten; when it is
 * already there and names the same bridge (username, uuid) the leftover old identity of an
 * interrupted pass is cleared, and when it names another bridge the pass fails rather than guess.
 * An incomplete or unreadable legacy identity is `already-done` or throws, and never mints a new
 * one (a new identity unpairs every controller).
 */
import { isSecretMarker, type MigrationProcedureResult } from '@camstack/types'
import {
  type HapBridgeBody,
  type HapBridgeIdentity,
  HAP_DEFAULT_PERSIST_DIR,
  identityOfBody,
} from '../hap-instance-kinds.js'

export interface IdentityToInstancePorts {
  /** The legacy identity, secrets resolved; null when no complete identity was ever stored. Throws when unreadable. */
  readLegacyIdentity(): Promise<Omit<HapBridgeIdentity, 'persistDir'> | null>
  /** The legacy bridge name, for the instance label. */
  readBridgeName(): Promise<string>
  /** Put the default record with `ifRev: 0`; `exists` when one is already there. */
  putDefaultRecord(body: HapBridgeBody): Promise<'created' | 'exists'>
  /** The default record, secrets resolved; null when absent. */
  readDefaultRecord(): Promise<HapBridgeBody | null>
  /** Remove the old `identity` setting and release its keychain entry. */
  clearLegacyIdentity(): Promise<void>
}

export async function moveIdentityToDefaultInstance(
  ports: IdentityToInstancePorts,
): Promise<MigrationProcedureResult> {
  const legacy = await ports.readLegacyIdentity()
  if (legacy === null) return { outcome: 'already-done', summary: { moved: false } }
  const name = (await ports.readBridgeName()).trim()
  const body: HapBridgeBody = {
    name: name.length > 0 ? name : 'CamStack Bridge',
    username: legacy.username,
    uuid: legacy.uuid,
    pincode: legacy.pincode,
    persistDir: HAP_DEFAULT_PERSIST_DIR,
  }
  const put = await ports.putDefaultRecord(body)
  const held = await ports.readDefaultRecord()
  if (held === null) throw new Error('the HomeKit default instance record cannot be read back')
  if (put === 'exists') {
    if (held.username !== body.username || held.uuid !== body.uuid) {
      throw new Error('the HomeKit default instance is another bridge than the stored identity')
    }
    await ports.clearLegacyIdentity()
    return { outcome: 'done', summary: { moved: false, cleared: true } }
  }
  if (!sameIdentity(identityOfBody(held), identityOfBody(body))) {
    throw new Error('the HomeKit default instance does not hold the identity it adopted')
  }
  await ports.clearLegacyIdentity()
  return { outcome: 'done', summary: { moved: true } }
}

function sameIdentity(a: HapBridgeIdentity, b: HapBridgeIdentity): boolean {
  return (
    a.username === b.username &&
    a.uuid === b.uuid &&
    a.pincode === b.pincode &&
    a.persistDir === b.persistDir
  )
}

/**
 * The identity a settings value describes, secrets resolved; null when it is not a complete
 * identity (first boot, or the empty sentinel). A pincode still a keychain marker was not
 * resolved: that throws, because treating "unreadable" as "absent" would mint a new identity.
 */
export function legacyIdentityOf(value: unknown): Omit<HapBridgeIdentity, 'persistDir'> | null {
  if (typeof value !== 'object' || value === null) return null
  const username: unknown = Reflect.get(value, 'username')
  const uuid: unknown = Reflect.get(value, 'uuid')
  const pincode: unknown = Reflect.get(value, 'pincode')
  if (isSecretMarker(pincode)) throw new Error('the stored HomeKit setup code cannot be resolved')
  if (
    typeof username !== 'string' ||
    typeof uuid !== 'string' ||
    typeof pincode !== 'string' ||
    username === '' ||
    uuid === '' ||
    pincode === ''
  ) {
    return null
  }
  return { username, uuid, pincode }
}
