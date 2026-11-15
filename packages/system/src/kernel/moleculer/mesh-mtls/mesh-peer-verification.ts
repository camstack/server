/**
 * The hub's judgement of a mesh peer's leaf (#558, amends D857).
 *
 * Node verifies the chain and the clock in one step and reports a single error, so an expired leaf
 * and a forged one both fail the handshake. The listener therefore keeps verification ON but lets
 * the handshake finish (`rejectUnauthorized: false` reports `authorized` / `authorizationError`),
 * and decides here, explicitly: a peer is admitted when it is authorized, or - on the hub only -
 * when its sole failure is `CERT_HAS_EXPIRED` AND an independent check proves the leaf is signed by
 * the mesh CA, is a client-auth end entity, has started, and is not on the CRL. Revocation stays the
 * kill switch.
 */
import { X509Certificate } from 'node:crypto'
import { CLIENT_AUTH_OID } from './constants.js'
import { subjectCn } from './mesh-ca.js'
import type { MeshCrl } from './mesh-crl.js'

export type MeshRefusalReason =
  | 'no-certificate'
  | 'not-chained'
  | 'expired'
  | 'not-yet-valid'
  | 'revoked'
  | 'cn-mismatch'

export interface MeshPeerAdmitted {
  readonly admit: true
  readonly nodeId: string
  readonly serial: string
  /** The leaf is past its notAfter: the hub recovers it. */
  readonly expired: boolean
  readonly notAfter: number
}

export interface MeshPeerRefused {
  readonly admit: false
  readonly reason: MeshRefusalReason
  readonly nodeId: string | null
  readonly detail: string
}

export type MeshPeerVerdict = MeshPeerAdmitted | MeshPeerRefused

export interface MeshPeerJudgement {
  /** DER of the presented leaf, when there is one. */
  readonly leafDer: Buffer | undefined
  readonly authorized: boolean
  /** Node's `authorizationError` (an OpenSSL code name such as `CERT_HAS_EXPIRED`). */
  readonly authorizationError: string | null
  readonly caCertPem: string
  readonly crl: MeshCrl
  /** The hub recovers an expired leaf; an enrolled agent does not. */
  readonly admitExpired: boolean
  readonly now: number
}

function chainsToCa(leaf: X509Certificate, ca: X509Certificate, now: number): boolean {
  if (now < Date.parse(ca.validFrom) || now > Date.parse(ca.validTo)) return false
  if (!leaf.checkIssued(ca)) return false
  if (!leaf.verify(ca.publicKey)) return false
  if (leaf.ca) return false
  return (leaf.keyUsage ?? []).includes(CLIENT_AUTH_OID)
}

function refused(
  reason: MeshRefusalReason,
  nodeId: string | null,
  detail: string,
): MeshPeerRefused {
  return { admit: false, reason, nodeId, detail }
}

export function judgeMeshPeerLeaf(input: MeshPeerJudgement): MeshPeerVerdict {
  if (input.leafDer === undefined) return refused('no-certificate', null, 'no client certificate')
  let leaf: X509Certificate
  let ca: X509Certificate
  try {
    leaf = new X509Certificate(input.leafDer)
    ca = new X509Certificate(input.caCertPem)
  } catch {
    return refused('not-chained', null, 'unparseable certificate')
  }
  const nodeId = subjectCn(leaf.subject)
  if (nodeId === null || nodeId.length === 0) return refused('cn-mismatch', null, 'leaf has no CN')

  const timeOnly = !input.authorized && input.authorizationError === 'CERT_HAS_EXPIRED'
  if (!input.authorized && !timeOnly) {
    const early = input.authorizationError === 'CERT_NOT_YET_VALID'
    return refused(
      early ? 'not-yet-valid' : 'not-chained',
      nodeId,
      input.authorizationError ?? 'unverified',
    )
  }
  if (timeOnly) {
    if (!chainsToCa(leaf, ca, input.now)) {
      return refused('not-chained', nodeId, 'expired and not signed by the mesh CA')
    }
    if (input.now < Date.parse(leaf.validFrom))
      return refused('not-yet-valid', nodeId, 'leaf not valid yet')
  }
  const serial = leaf.serialNumber
  if (input.crl.isRevoked(serial)) return refused('revoked', nodeId, `serial ${serial} is revoked`)
  if (timeOnly && !input.admitExpired) return refused('expired', nodeId, 'leaf expired')
  return { admit: true, nodeId, serial, expired: timeOnly, notAfter: Date.parse(leaf.validTo) }
}
