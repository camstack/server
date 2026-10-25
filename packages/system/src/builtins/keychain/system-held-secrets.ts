/**
 * Secrets the hub itself owns (keychain owner `system`, D797) and where their
 * markers live — what the orphan check needs to know about them.
 *
 *  - The session signing key is HELD by the process (`local-auth` loads it at
 *    boot); no settings blob points at it, so it is always "in use" and never
 *    offered for deletion as an orphan.
 *  - The mesh CA key is HELD the same way (mesh mTLS issuance); the public
 *    certificate lives in `system-settings` `cluster.meshCa`.
 *  - No form-owned system secret remains: the cluster secret was removed (D857) and the
 *    mesh certificate is the node identity. A `system/global/clusterSecret` entry left in
 *    the keychain by an older hub is NOT recognised here, so it reads as an orphan the
 *    operator deletes by hand; nothing reads or writes it any more.
 */
import type { SystemHeldSecretName } from '@camstack/types'
import { JWT_SIGNING_KEY_REF, SYSTEM_SECRET_OWNER } from '../../auth/jwt-signing-key.js'
import { DEVICE_CA_KEY_REF } from '../../auth/device-ca.js'
import { MESH_CA_KEY_REF } from '../../kernel/moleculer/mesh-mtls/constants.js'

export { SYSTEM_SECRET_OWNER }

/** The refs `keychain-admin.setSystemSecret` may write, by name. */
export const SYSTEM_HELD_SECRET_REFS: Readonly<Record<SystemHeldSecretName, string>> = {
  'jwt-signing-key': JWT_SIGNING_KEY_REF,
}

/** System refs no blob points at — in use for as long as they exist. */
export const PROCESS_HELD_SECRET_REFS: ReadonlySet<string> = new Set([
  JWT_SIGNING_KEY_REF,
  MESH_CA_KEY_REF,
  DEVICE_CA_KEY_REF,
])

/** `system-settings` keys that may hold a system-owned secret's marker. */
export const SYSTEM_SECRET_SETTINGS_KEYS: readonly string[] = []

export { MESH_CA_KEY_REF }
