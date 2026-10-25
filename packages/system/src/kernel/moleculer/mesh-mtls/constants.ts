/**
 * Mesh mTLS constants (Release A — plan 2026-10-09-mesh-mtls-plan).
 */
import { buildSecretRef } from '@camstack/types'

/** Same owner as the JWT signing key (D797). */
const SYSTEM_SECRET_OWNER = 'system'

/** `secret://system/global/meshCaKey` — EC P-256 PKCS#8 PEM of the hub mesh CA. */
export const MESH_CA_KEY_REF: string = buildSecretRef({
  owner: SYSTEM_SECRET_OWNER,
  scope: { kind: 'global' },
  fieldPath: 'meshCaKey',
})

/** `system-settings` key holding the public CA certificate PEM. */
export const MESH_CA_SETTINGS_KEY = 'cluster.meshCa'

/** Field inside the `cluster` section. */
export const MESH_CA_FIELD = 'meshCa'

/** Leaf lifetimes. */
export const MESH_LEAF_VALIDITY_DAYS = 30
export const MESH_CA_VALIDITY_DAYS = 3650

/** Hub legacy clear TCP (retired on hub — D826) and TLS listen port. */
export const DEFAULT_HUB_TCP_PORT = 6000
export const DEFAULT_HUB_TLS_TCP_PORT = 6443

/** Subject of the mesh root. Distinct from the HTTPS local CA. */
export const MESH_CA_COMMON_NAME = 'CamStack Mesh CA'

/** Client + server auth EKU OIDs (mutual TLS). */
export const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1'
export const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2'
