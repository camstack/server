import { z } from 'zod'
import {
  DeviceCredentialSchema,
  DeviceCredentialStatusSchema,
  StartEnrollmentOutputSchema,
} from '../auth/device-certificate.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

export const DeviceCaStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('absent') }),
  z.object({
    state: z.literal('ready'),
    subject: z.string(),
    fingerprintSha256: z.string(),
    validTo: z.string(),
  }),
  z.object({ state: z.literal('unavailable'), reason: z.string() }),
])
export type DeviceCaStatus = z.infer<typeof DeviceCaStatusSchema>

export const DeviceCertificateSettingsSchema = z.object({
  selfEnrollment: z.enum(['allowed', 'disabled']),
})
export type DeviceCertificateSettings = z.infer<typeof DeviceCertificateSettingsSchema>

/**
 * `device-credentials` — the admin surface of device certificates (D855).
 *
 * Everything a device does ITSELF — completing an enrollment, getting a
 * challenge, signing in, renewing — is a PUBLIC procedure of the hub's `auth`
 * router (`auth.completeEnrollment`, `getDeviceChallenge`,
 * `loginWithDeviceCertificate`, `renewDeviceCertificate`): those legs are
 * proofs of possession, not capability calls, and must not be reachable as
 * cap methods. This cap holds only what an operator does about them.
 *
 * Provider: `local-auth`, which also owns the device CA and the registry.
 * The hub is the only node that persists device credentials.
 */
export const deviceCredentialsCapability = {
  name: 'device-credentials',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /**
     * Every enrolled device, newest first; `userId` narrows to one user.
     * `status` is derived: revoked wins over expired.
     */
    listDeviceCredentials: method(
      z.object({
        userId: z.string().min(1).optional(),
        includeRevoked: z.boolean().default(false),
      }),
      z.array(DeviceCredentialSchema).readonly(),
      { auth: 'admin' },
    ),

    /**
     * Mint a one-shot enrollment code for `userId` and a device name: 128-bit
     * random, single use, 10 minutes, kept only as a hash. Returns the code
     * once, with the `camstack://enroll?hub=…&code=…` link a QR carries.
     * `caller` (the admin) is recorded in the audit trail.
     */
    startEnrollment: method(
      z.object({
        userId: z.string().min(1),
        deviceName: z.string().min(1).max(80),
      }),
      StartEnrollmentOutputSchema,
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),

    /**
     * Revoke a credential: its certificate stops logging in at once, and every
     * session it opened ends (an open session also dies at its next refresh
     * even if this call raced it). Idempotent.
     */
    revokeDeviceCredential: method(
      z.object({ id: z.string().min(1) }),
      z.object({
        revoked: z.boolean(),
        sessionsEnded: z.number().int(),
        status: DeviceCredentialStatusSchema,
      }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),

    /**
     * Hub-wide device-certificate settings. `selfEnrollment`: `allowed`
     * (default) lets a signed-in user enroll their own device after a step-up
     * sign-in; `disabled` makes `auth.enrollSelf` refuse. The admin QR path is
     * unaffected. Hub-wide only (no per-role switch).
     */
    getDeviceCertificateSettings: method(z.object({}), DeviceCertificateSettingsSchema, {
      auth: 'admin',
    }),
    setDeviceCertificateSettings: method(
      DeviceCertificateSettingsSchema,
      DeviceCertificateSettingsSchema,
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),

    /**
     * Delete the registry row of a REVOKED credential (clean-up; the audit trail
     * keeps the revocation). Refuses a live credential: revoke it first. After
     * the row is gone the device's next call answers `unknown-credential`.
     */
    deleteDeviceCredential: method(
      z.object({ id: z.string().min(1) }),
      z.object({ result: z.enum(['deleted', 'live', 'unknown']) }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),

    /**
     * The device CA: `absent` until the first enrollment creates it (lazily,
     * never rotated on boot), `unavailable` while the keychain cannot answer.
     */
    getDeviceCaStatus: method(z.object({}), DeviceCaStatusSchema, { auth: 'admin' }),

    /** Rename a credential (the label only; the certificate is unchanged). */
    renameDeviceCredential: method(
      z.object({ id: z.string().min(1), deviceName: z.string().min(1).max(80) }),
      z.object({ renamed: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IDeviceCredentialsProvider = InferProvider<typeof deviceCredentialsCapability>
