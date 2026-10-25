/**
 * Pure model of Identity → Certificates (D855, D856): the row types the three
 * tables render, and every decision the screens make about a row (status,
 * whether Renew is offered, what a failed handover is called). No React here, so
 * each rule is pinned by a plain spec.
 */
import type { trpc } from '@camstack/ui-library'
import i18n from '../../i18n/index'

type Utils = ReturnType<typeof trpc.useUtils>

/** What a procedure answers: the awaited result of its cache-utils `fetch`. */
type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>

/** One enrolled device, as `deviceCredentials.listDeviceCredentials` returns it. */
export type DeviceCredentialRow = Answer<
  Utils['deviceCredentials']['listDeviceCredentials']['fetch']
>[number]
export type OwnDeviceCredentialRow = Answer<
  Utils['auth']['listOwnDeviceCredentials']['fetch']
>[number]
export type HttpsNodeRow = Answer<Utils['certificates']['listHttpsCertificates']['fetch']>[number]
export type MeshInventory = Answer<Utils['certificates']['getMeshCertificates']['fetch']>
export type MeshNodeRow = MeshInventory['nodes'][number]
export type MeshLeafRow = NonNullable<MeshNodeRow['current']>
export type MeshRenewResult = Awaited<
  ReturnType<ReturnType<typeof trpc.certificates.renewMeshOnNode.useMutation>['mutateAsync']>
>

export const DAY_MS = 86_400_000

/** A leaf with fewer days than this left is called out in the tables. */
export const EXPIRING_SOON_DAYS = 30

export type DeviceStatus = DeviceCredentialRow['status']

export const DEVICE_STATUS_LABEL: Readonly<Record<DeviceStatus, string>> = {
  active: 'Valid',
  expired: 'Expired',
  revoked: 'Revoked',
}

export const DEVICE_STATUS_VARIANT: Readonly<
  Record<DeviceStatus, 'success' | 'warning' | 'default'>
> = {
  active: 'success',
  expired: 'warning',
  revoked: 'default',
}

/** Status sort rank: live first, dead last. */
export const DEVICE_STATUS_RANK: Readonly<Record<DeviceStatus, number>> = {
  active: 0,
  expired: 1,
  revoked: 2,
}

export const ENROLLED_VIA_LABEL: Readonly<Record<DeviceCredentialRow['enrolledVia'], string>> = {
  qr: 'QR (by an admin)',
  self: 'Self-enrolled',
}

export const PLATFORM_LABEL: Readonly<Record<DeviceCredentialRow['platform'], string>> = {
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
  other: 'Other',
}

/** Any row (a device record or its Tokens-table twin) that carries a status. */
export interface StatusCarrier {
  readonly status: string
}

/** Only a revoked credential's row may be deleted; a live one is revoked first. */
export function canDeleteDevice(row: StatusCarrier): boolean {
  return row.status === 'revoked'
}

export function canRevokeDevice(row: StatusCarrier): boolean {
  return row.status !== 'revoked'
}

export function formatDateTime(ms: number | null, none = '—'): string {
  if (ms === null) return none
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? none : d.toLocaleString()
}

/** Whole days from `now` to `ms` (negative once passed); `null` for an unreadable date. */
export function daysUntil(ms: number | null, now: number): number | null {
  if (ms === null || Number.isNaN(ms)) return null
  return Math.floor((ms - now) / DAY_MS)
}

export type ExpiryTone = 'ok' | 'soon' | 'expired' | 'unknown'

export function expiryTone(ms: number | null, now: number): ExpiryTone {
  const days = daysUntil(ms, now)
  if (days === null) return 'unknown'
  if (days < 0) return 'expired'
  return days < EXPIRING_SOON_DAYS ? 'soon' : 'ok'
}

/** "in 12 days" / "3 days ago" / "today". */
export function describeExpiry(ms: number | null, now: number): string {
  const days = daysUntil(ms, now)
  if (days === null) return i18n.t('helpers.certificateModel.unknown')
  if (days === 0) return i18n.t('helpers.certificateModel.today')
  if (days > 0) return i18n.t('helpers.certificateModel.inDays', { count: days })
  return i18n.t('helpers.certificateModel.daysAgo', { count: -days })
}

/** `validTo` of an HTTPS row is an ISO/date string; the tables work in epoch ms. */
export function dateStringToMs(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** First and last bytes of a fingerprint: enough to recognise, not to compare. */
export function shortFingerprint(fp: string | null): string {
  if (fp === null || fp.length === 0) return '—'
  return fp.length <= 17 ? fp : `${fp.slice(0, 8)}…${fp.slice(-8)}`
}

export function shortSerial(serial: string): string {
  return serial.length <= 10 ? serial : `${serial.slice(0, 10)}…`
}

export interface RenewPolicy {
  readonly allowed: boolean
  /** Why it is not offered; `null` when it is. */
  readonly reason: string | null
}

/**
 * Whether "Renew" is offered for a node's HTTPS certificate. A certificate the
 * operator uploaded on the hub is never replaced from this button: the server
 * refuses it as well, but a button that is offered and then fails is worse
 * than one that says why it is off.
 */
export function httpsRenewPolicy(row: HttpsNodeRow): RenewPolicy {
  if (!row.online) {
    return {
      allowed: false,
      reason: i18n.t('helpers.certificateModel.nodeOffline'),
    }
  }
  if (row.isHub && row.https.kind === 'served') {
    if (row.https.status.mode === 'uploaded') {
      return {
        allowed: false,
        reason: i18n.t('helpers.certificateModel.uploadedCert'),
      }
    }
    if (row.https.status.mode === 'disabled') {
      return {
        allowed: false,
        reason: i18n.t('helpers.certificateModel.tlsDisabled'),
      }
    }
  }
  return { allowed: true, reason: null }
}

export type MeshStage = Extract<MeshRenewResult, { ok: false }>['stage']

export const MESH_STAGE_LABEL_KEY: Readonly<Record<MeshStage, string>> = {
  prepare: 'helpers.certificateModel.stage.prepare',
  issue: 'helpers.certificateModel.stage.issue',
  install: 'helpers.certificateModel.stage.install',
  reconnect: 'helpers.certificateModel.stage.reconnect',
  confirm: 'helpers.certificateModel.stage.confirm',
}

export interface Outcome {
  readonly tone: 'success' | 'danger'
  readonly message: string
}

/** The one line a mesh renewal ends in, naming the stage when it failed. */
export function describeMeshRenewal(result: MeshRenewResult): Outcome {
  if (result.ok) {
    return {
      tone: 'success',
      message: i18n.t('helpers.certificateModel.renewed', {
        nodeId: result.nodeId,
        serial: shortSerial(result.newSerial),
      }),
    }
  }
  const kept = result.keptPreviousLeaf
    ? i18n.t('helpers.certificateModel.keptPrevious')
    : i18n.t('helpers.certificateModel.maybeNoCert')
  return {
    tone: 'danger',
    message: i18n.t('helpers.certificateModel.renewalFailed', {
      nodeId: result.nodeId,
      stage: i18n.t(MESH_STAGE_LABEL_KEY[result.stage]),
      reason: result.reason,
      kept,
    }),
  }
}

export interface Countdown {
  readonly expired: boolean
  /** "9:41". */
  readonly label: string
}

export function countdown(expiresAt: number, now: number): Countdown {
  const left = Math.max(0, expiresAt - now)
  const totalSeconds = Math.ceil(left / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return {
    expired: left === 0,
    label: `${String(minutes)}:${String(seconds).padStart(2, '0')}`,
  }
}
