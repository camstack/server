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

/**
 * A mesh leaf does not expire (#558, amends D857): RFC 5280 section 4.1.2.5 "no well-defined
 * expiration date" is 9999-12-31T23:59:59Z. Identity ends by revocation (the CRL) or by an explicit
 * rotation (`certificates.renewMeshOnNode`), never by the clock.
 */
export const MESH_LEAF_NOT_AFTER: Date = new Date('9999-12-31T23:59:59Z')

/** The mesh CA lifetime. Leaves outlive it on purpose: chain building does not nest validity. */
export const MESH_CA_VALIDITY_DAYS = 3650

/** Hub legacy clear TCP (retired on hub — D826) and TLS listen port. */
export const DEFAULT_HUB_TCP_PORT = 6000
export const DEFAULT_HUB_TLS_TCP_PORT = 6443

/** Subject of the mesh root. Distinct from the HTTPS local CA. */
export const MESH_CA_COMMON_NAME = 'CamStack Mesh CA'

/** Client + server auth EKU OIDs (mutual TLS). */
export const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1'
export const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2'
