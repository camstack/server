/**
 * Device certificates (D855) — the wire contract shared by the hub, the admin
 * UI and the native viewer.
 *
 * A device (a phone) generates its OWN P-256 key pair in hardware (Secure
 * Enclave / Android Keystore / a non-extractable WebCrypto key). The private
 * key never travels. The hub signs the PUBLIC key into an X.509 leaf under a
 * dedicated device CA; the device later proves possession of the key by
 * signing a hub-issued nonce, and the hub answers with the same session a
 * password login opens.
 *
 * Everything on the wire is a small string (a PEM, a base64url signature):
 * D613 is about bulk bytes, and a certificate is ~600 bytes.
 */
import { z } from 'zod'
import { AppLoginPathSchema } from './app-flow.js'

/** Signature algorithm of every device credential: ECDSA, curve P-256, SHA-256. */
export const DEVICE_CERT_SIGNATURE = 'ecdsa-p256-sha256' as const

/** First line of every signed message; a change of format bumps the version. */
export const DEVICE_SIGNATURE_MESSAGE_VERSION = 'camstack-device-cert-v1' as const

/** What a signature is for. A login signature can never be replayed as a renewal. */
export const DeviceSignaturePurposeSchema = z.enum(['login', 'renew', 'revoke'])
export type DeviceSignaturePurpose = z.infer<typeof DeviceSignaturePurposeSchema>

/** Leaf lifetime and the window in which the app renews it. */
export const DEVICE_CERT_VALIDITY_DAYS = 365
export const DEVICE_CERT_RENEW_WINDOW_DAYS = 30

/** One-shot enrollment code and login nonce lifetimes. */
export const DEVICE_ENROLLMENT_TTL_MS = 10 * 60_000
export const DEVICE_NONCE_TTL_MS = 60_000

/** SAN URI prefixes of a device leaf. */
export const DEVICE_SAN_CREDENTIAL_PREFIX = 'camstack:credential:' as const
export const DEVICE_SAN_USER_PREFIX = 'camstack:user:' as const

/**
 * The exact bytes a device signs (UTF-8, `\n` separators, no trailing newline):
 *
 *   camstack-device-cert-v1
 *   <login|renew>
 *   <origin>            the hub origin returned by `getDeviceChallenge`
 *   <nonce>
 *
 * The origin is part of the message so a signature collected by a look-alike
 * hub is worthless on the real one; the hub additionally binds the nonce to
 * the origin it issued it for and refuses any other.
 */
export function buildDeviceSignatureMessage(input: {
  readonly purpose: DeviceSignaturePurpose
  readonly origin: string
  readonly nonce: string
}): string {
  return [DEVICE_SIGNATURE_MESSAGE_VERSION, input.purpose, input.origin, input.nonce].join('\n')
}

/** The deep link a QR carries: `camstack://enroll?hub=<origin>&code=<code>`. */
export function buildDeviceEnrollmentLink(input: {
  readonly hub?: string
  readonly code: string
  readonly scheme?: string
}): string {
  const query = new URLSearchParams()
  if (input.hub !== undefined) query.set('hub', input.hub)
  query.set('code', input.code)
  return `${input.scheme ?? 'camstack'}://enroll?${query.toString()}`
}

/** Parse an enrollment deep link; `null` when it is not one. `hub` is absent when the link names none. */
export function parseDeviceEnrollmentLink(
  raw: string,
): { readonly hub: string | null; readonly code: string } | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'camstack:' && url.protocol !== 'camstack.dev:') return null
  if (url.hostname !== 'enroll') return null
  const code = url.searchParams.get('code')
  if (code === null || code === '') return null
  const hub = url.searchParams.get('hub')
  return { hub: hub === null || hub === '' ? null : hub, code }
}

export const DevicePlatformSchema = z.enum(['ios', 'android', 'web', 'other'])
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>

const Base64UrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/)
const PemSchema = z.string().min(1).max(16384)

// ── Typed refusals ──────────────────────────────────────────────────────

/**
 * Why a device-certificate endpoint said no. Distinct from a transport / 5xx
 * failure: those carry no reason and mean "try again", never "the credential is
 * dead". The viewer switches on this exhaustively.
 */
export const DeviceRefusalReasonSchema = z.enum([
  /** The credential was revoked (admin, owner or the device). DEFINITIVE. */
  'revoked',
  /** The credential id is not in the registry (row deleted). DEFINITIVE. */
  'unknown-credential',
  /** The certificate is past `notAfter`. Not definitive: the app may re-enroll. */
  'expired',
  'bad-signature',
  /** Unknown, expired or already-used nonce, or bound to another origin: ask for a new one. */
  'nonce-invalid',
  'rate-limited',
  /** The certificate is not one this hub's device CA issued, or is malformed. */
  'invalid-certificate',
  /** A renewed certificate replaced this one (past the 24 h grace): the device lost the newest one. Not definitive. */
  'superseded',
  /** The user of the credential no longer exists. DEFINITIVE. */
  'user-gone',
  /** The hub cannot check right now (device CA / keychain unavailable). Retry later. */
  'unavailable',
  /** Enrollment-only reasons. */
  'code-invalid',
  'self-enrollment-disabled',
  'step-up-required',
  'bad-public-key',
])
export type DeviceRefusalReason = z.infer<typeof DeviceRefusalReasonSchema>

/** The only answers after which the app may count towards deleting its credential. */
export const DEFINITIVE_DEVICE_REFUSALS: readonly DeviceRefusalReason[] = [
  'revoked',
  'unknown-credential',
  'user-gone',
]

/** Consecutive DEFINITIVE answers before the app deletes its key and certificate. */
export const DEVICE_DEFINITIVE_REFUSALS_BEFORE_DELETE = 3

export function isDefinitiveDeviceRefusal(reason: DeviceRefusalReason): boolean {
  return DEFINITIVE_DEVICE_REFUSALS.includes(reason)
}

export const DeviceRefusalSchema = z.object({
  ok: z.literal(false),
  reason: DeviceRefusalReasonSchema,
  definitive: z.boolean(),
  retryAfterSeconds: z.number().optional(),
})
export type DeviceRefusal = z.infer<typeof DeviceRefusalSchema>

/**
 * A credential-bound session that can no longer refresh answers
 * `auth.refreshSession` with UNAUTHORIZED whose message is this prefix + the
 * reason; {@link deviceRefusalFromMessage} reads it back.
 */
export const DEVICE_REFRESH_REFUSAL_PREFIX = 'device-credential:' as const

export function deviceRefusalFromMessage(message: string): DeviceRefusalReason | null {
  if (!message.startsWith(DEVICE_REFRESH_REFUSAL_PREFIX)) return null
  const parsed = DeviceRefusalReasonSchema.safeParse(
    message.slice(DEVICE_REFRESH_REFUSAL_PREFIX.length),
  )
  return parsed.success ? parsed.data : null
}

// ── Public procedures (auth router) ─────────────────────────────────────

export const CompleteEnrollmentInputSchema = z.object({
  code: z.string().min(1).max(256),
  /** SubjectPublicKeyInfo DER of the device's P-256 public key, base64url. */
  publicKeySpki: Base64UrlSchema,
  deviceName: z.string().min(1).max(80).optional(),
  platform: DevicePlatformSchema,
})
export type CompleteEnrollmentInput = z.infer<typeof CompleteEnrollmentInputSchema>

export const CompleteEnrollmentOutputSchema = z.object({
  credentialId: z.string(),
  certPem: PemSchema,
  /** The device CA certificate the leaf chains to. */
  chainPem: PemSchema,
  notAfter: z.number(),
  user: z.object({ id: z.string(), username: z.string() }),
})
export type CompleteEnrollmentOutput = z.infer<typeof CompleteEnrollmentOutputSchema>
export const CompleteEnrollmentResultSchema = z.discriminatedUnion('ok', [
  CompleteEnrollmentOutputSchema.extend({ ok: z.literal(true) }),
  DeviceRefusalSchema,
])
export type CompleteEnrollmentResult = z.infer<typeof CompleteEnrollmentResultSchema>

export const EnrollSelfInputSchema = z.object({
  /** The single-use step-up proof (`auth.deviceEnrollProofFrom…`). */
  proof: z.string().min(1).max(512),
  publicKeySpki: Base64UrlSchema,
  deviceName: z.string().min(1).max(80),
  platform: DevicePlatformSchema,
})
export type EnrollSelfInput = z.infer<typeof EnrollSelfInputSchema>

export const DeviceEnrollProofSchema = z.object({ proof: z.string(), expiresAt: z.number() })

export const DeviceChallengeSchema = z.object({
  nonce: z.string(),
  /** The origin to put in the signed message. The app compares it to the hub it dialled. */
  origin: z.string(),
  expiresAt: z.number(),
  signature: z.literal(DEVICE_CERT_SIGNATURE),
})
export type DeviceChallenge = z.infer<typeof DeviceChallengeSchema>
export const DeviceChallengeResultSchema = z.discriminatedUnion('ok', [
  DeviceChallengeSchema.extend({ ok: z.literal(true) }),
  DeviceRefusalSchema,
])
export type DeviceChallengeResult = z.infer<typeof DeviceChallengeResultSchema>

export const DeviceProofInputSchema = z.object({
  certPem: PemSchema,
  nonce: z.string().min(1).max(256),
  /** ECDSA P-256 SHA-256 over {@link buildDeviceSignatureMessage}; raw r||s or DER, base64url. */
  signature: Base64UrlSchema,
})
export type DeviceProofInput = z.infer<typeof DeviceProofInputSchema>

export const RenewDeviceCertificateOutputSchema = z.object({
  credentialId: z.string(),
  certPem: PemSchema,
  chainPem: PemSchema,
  notAfter: z.number(),
})
export type RenewDeviceCertificateOutput = z.infer<typeof RenewDeviceCertificateOutputSchema>
export const RenewDeviceCertificateResultSchema = z.discriminatedUnion('ok', [
  RenewDeviceCertificateOutputSchema.extend({ ok: z.literal(true) }),
  DeviceRefusalSchema,
])
export type RenewDeviceCertificateResult = z.infer<typeof RenewDeviceCertificateResultSchema>

export const RevokeOwnDeviceCertificateResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), credentialId: z.string(), sessionsEnded: z.number().int() }),
  DeviceRefusalSchema,
])
export type RevokeOwnDeviceCertificateResult = z.infer<
  typeof RevokeOwnDeviceCertificateResultSchema
>

/** Who revoked a credential, as `revokedBy` records it: `admin:<userId>` | `user:<userId>` | `device`. */
export type DeviceRevoker =
  | { readonly kind: 'admin'; readonly userId: string }
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'device' }
export function formatDeviceRevoker(revoker: DeviceRevoker): string {
  return revoker.kind === 'device' ? 'device' : `${revoker.kind}:${revoker.userId}`
}

// ── Admin cap shapes ───────────────────────────────────────────────────

export const DeviceCredentialStatusSchema = z.enum(['active', 'expired', 'revoked'])
export type DeviceCredentialStatus = z.infer<typeof DeviceCredentialStatusSchema>

export const DeviceCredentialSchema = z.object({
  id: z.string(),
  userId: z.string(),
  username: z.string().nullable(),
  deviceName: z.string(),
  platform: DevicePlatformSchema,
  enrolledVia: z.enum(['qr', 'self']),
  /** SHA-256 of the leaf certificate DER, colon-hex. */
  fingerprint: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
  lastUsedAt: z.number().nullable(),
  lastUsedFrom: z.string().nullable(),
  revokedAt: z.number().nullable(),
  /** `admin:<userId>` | `user:<userId>` | `device` | `user-deleted`. */
  revokedBy: z.string().nullable(),
  status: DeviceCredentialStatusSchema,
})
export type DeviceCredential = z.infer<typeof DeviceCredentialSchema>

export const StartEnrollmentOutputSchema = z.object({
  /** Shown once; only its hash is kept. */
  code: z.string(),
  expiresAt: z.number(),
  /** `camstack://enroll?hub=…&code=…` — what the QR encodes. */
  enrollUrl: z.string(),
  /** The hub origin in the link, or `null` when the hub could not name one (the link then has no `hub`). */
  hubOrigin: z.string().nullable(),
  /** Every origin the apps may try (role `appConnections`). */
  hubOrigins: z.array(z.string()),
})
export type StartEnrollmentOutput = z.infer<typeof StartEnrollmentOutputSchema>

/** The `device-certificate` arm of `auth.listLoginMethods`. */
export const DeviceCertificateLoginMethodSchema = z.object({
  kind: z.literal('device-certificate'),
  id: z.literal('device-certificate'),
  label: z.string(),
  stage: z.literal('primary'),
  /** tRPC paths under the hub's `auth` router, so a client names no literal. */
  challengePath: z.literal('auth.getDeviceChallenge'),
  revokePath: z.literal('auth.revokeOwnDeviceCertificate'),
  enrollSelfPath: z.literal('auth.enrollSelf'),
  loginPath: z.literal('auth.loginWithDeviceCertificate'),
  renewPath: z.literal('auth.renewDeviceCertificate'),
  signature: z.literal(DEVICE_CERT_SIGNATURE),
  messageVersion: z.literal(DEVICE_SIGNATURE_MESSAGE_VERSION),
  /** Which clients can execute it: a native app silently, a browser with a non-extractable WebCrypto key. */
  clients: z.array(z.enum(['native', 'web'])),
  /** The app executes it itself, silently (D858). */
  app: AppLoginPathSchema.nullable(),
})
export type DeviceCertificateLoginMethod = z.infer<typeof DeviceCertificateLoginMethodSchema>
