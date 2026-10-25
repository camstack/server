/**
 * A paired device as a Tokens & sessions `CredentialRow` (D819), so the Devices
 * tables render through the SAME `CredentialTable` as every credential kind:
 * the same columns, filter chips, selection and bulk bar.
 *
 * name = the device, detail = its fingerprint prefix (and where it last signed
 * in from), kind = the platform, scope = how it was enrolled.
 */
import type { CredentialRow } from '../access/credential-row'
import {
  ENROLLED_VIA_LABEL,
  PLATFORM_LABEL,
  type DeviceCredentialRow,
  type OwnDeviceCredentialRow,
} from './certificate-model'

const FINGERPRINT_PREFIX = 11

function detailLine(fingerprint: string, from: string | null): string {
  const print = fingerprint.slice(0, FINGERPRINT_PREFIX)
  return from === null ? print : `${print} · ${from}`
}

export function deviceCredentialRow(d: DeviceCredentialRow): CredentialRow {
  return {
    id: d.id,
    name: d.deviceName,
    detail: detailLine(d.fingerprint, d.lastUsedFrom),
    ownerId: d.userId,
    ownerName: d.username ?? d.userId,
    kind: PLATFORM_LABEL[d.platform],
    scope: ENROLLED_VIA_LABEL[d.enrolledVia],
    status: d.status,
    createdAt: d.issuedAt,
    lastUsedAt: d.lastUsedAt,
    expiresAt: d.expiresAt,
  }
}

export function ownDeviceCredentialRow(
  d: OwnDeviceCredentialRow,
  ownerName: string,
): CredentialRow {
  return {
    id: d.id,
    name: d.deviceName,
    detail: null,
    ownerId: null,
    ownerName,
    kind: PLATFORM_LABEL[d.platform],
    scope: null,
    status: d.status,
    createdAt: d.issuedAt,
    lastUsedAt: d.lastUsedAt,
    expiresAt: d.expiresAt,
  }
}
