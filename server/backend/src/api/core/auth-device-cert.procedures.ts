/**
 * Device-certificate procedures of the `auth` router (D855).
 *
 * PUBLIC legs (a certificate + a signature over a hub nonce IS the credential):
 *   completeEnrollment · getDeviceChallenge · loginWithDeviceCertificate ·
 *   renewDeviceCertificate · revokeOwnDeviceCertificate
 * SIGNED-IN legs:
 *   enrollSelf (needs a single-use step-up proof) · deviceEnrollProofFromReauth ·
 *   deviceEnrollProofFromHandoff · listOwnDeviceCredentials ·
 *   revokeOwnDeviceCredential
 *
 * Every public leg answers a discriminated `{ ok: true … } | { ok: false,
 * reason, definitive }` — a typed refusal the app acts on, distinct from a
 * transport or 5xx failure (which carries no reason and never means "the
 * credential is dead"). Every refusal is logged by the credential manager with
 * its reason; rate-limit refusals are logged here.
 */
import type { CapabilityRegistry } from '@camstack/system'
import { getUserManagementInternal } from '@camstack/system'
import type { DeviceCheckRefusal } from '@camstack/system'
import {
  CompleteEnrollmentInputSchema,
  CompleteEnrollmentResultSchema,
  DEVICE_CERT_SIGNATURE,
  DeviceChallengeResultSchema,
  DeviceCredentialSchema,
  DeviceEnrollProofSchema,
  type DeviceRefusal,
  type DeviceRefusalReason,
  DeviceProofInputSchema,
  DeviceRefusalSchema,
  EnrollSelfInputSchema,
  formatDeviceRevoker,
  isDefinitiveDeviceRefusal,
  RenewDeviceCertificateResultSchema,
  RevokeOwnDeviceCertificateResultSchema,
} from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { AuthNetworkPolicy } from '../../auth/auth-network-policy.js'
import type { RateLimiter } from '../../auth/auth-rate-limit.js'
import type { DeviceEnrollProofs } from '../../auth/device-enroll-proofs.js'
import {
  type SessionIssue,
  type SessionMinter,
  SessionUserGoneError,
} from '../../auth/session-mint.js'
import type { AuthService } from '../../core/auth/auth.service.js'
import type { HandoffCodeService } from '../../core/auth/handoff-code.service.js'
import type { TrpcRequest } from '../trpc/trpc.context.js'
import { protectedProcedure, type publicProcedure } from '../trpc/trpc.middleware.js'
import { assertReauthenticated, ReauthTokenInput } from './auth-reauth.procedures.js'
import { trpcUserError } from '../trpc/user-error.js'

const DeviceLoginResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    token: z.string(),
    user: z.object({ id: z.string(), username: z.string(), isAdmin: z.boolean() }),
    expiresAt: z.number().optional(),
    sessionId: z.string().optional(),
    sessionExpiresAt: z.number().optional(),
    refreshToken: z.string().optional(),
    credentialId: z.string(),
    /** The certificate's expiry (epoch ms): the app renews when < 30 days remain. */
    certNotAfter: z.number(),
  }),
  DeviceRefusalSchema,
])

export interface DeviceCertProcedureDeps {
  readonly registry: CapabilityRegistry | null
  readonly minter: SessionMinter
  /** Public procedure; limiting is done here so a refusal can be TYPED. */
  readonly publicProcedure: typeof publicProcedure
  readonly auth: Pick<AuthService, 'verifyReauthToken'>
  readonly credentialLimiter: RateLimiter
  readonly ceremonyLimiter: RateLimiter
  /** Per-user limiter for the signed-in legs. */
  readonly selfLimiter: RateLimiter
  readonly network: AuthNetworkPolicy
  readonly enrollProofs: DeviceEnrollProofs
  readonly handoffCodes: HandoffCodeService
  /** The hub origin THIS request is entitled to (advertised address set). */
  readonly resolveOrigin: (req: TrpcRequest | undefined) => Promise<string | null>
  readonly issueFor: (
    req: TrpcRequest | undefined,
    method: SessionIssue['method'],
    refreshable: boolean | undefined,
  ) => SessionIssue
  readonly logger?: {
    warn(
      message: string,
      extras?: { tags?: Record<string, string>; meta?: Record<string, unknown> },
    ): void
  }
}

/** Internal manager reason → the wire reason an app switches on. */
export function toWireReason(reason: DeviceCheckRefusal): DeviceRefusalReason {
  switch (reason) {
    case 'revoked':
    case 'unknown-credential':
    case 'expired':
    case 'bad-signature':
    case 'user-gone':
    case 'bad-public-key':
    case 'self-enrollment-disabled':
      return reason
    case 'unknown-or-used-code':
    case 'expired-code':
      return 'code-invalid'
    case 'unknown-nonce':
    case 'expired-nonce':
      return 'nonce-invalid'
    case 'ca-unavailable':
      return 'unavailable'
    case 'no-device-ca':
    case 'malformed-certificate':
    case 'not-issued-by-device-ca':
    case 'not-yet-valid':
    case 'missing-credential-san':
    case 'missing-client-auth':
    case 'key-mismatch':
    case 'user-mismatch':
      return 'invalid-certificate'
    case 'superseded':
      return 'superseded'
  }
}

export function refusal(reason: DeviceRefusalReason, retryAfterSeconds?: number): DeviceRefusal {
  return {
    ok: false,
    reason,
    definitive: isDefinitiveDeviceRefusal(reason),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  }
}

function fromAddress(req: TrpcRequest | undefined, network: AuthNetworkPolicy): string | undefined {
  const ip = network.clientAddress(req).ip
  return ip ?? undefined
}

export function createDeviceCertProcedures(deps: DeviceCertProcedureDeps) {
  const internal = () => {
    const found =
      deps.registry === null
        ? null
        : getUserManagementInternal(deps.registry.getSingleton('user-management'))
    if (found === null) {
      throw trpcUserError(
        'PRECONDITION_FAILED',
        'device.certificates-unavailable',
        undefined,
        'Device certificates are not available',
      )
    }
    return found
  }

  /** `null` when allowed; otherwise a TYPED `rate-limited` refusal, logged. */
  const limited = (
    limiter: RateLimiter,
    path: string,
    req: TrpcRequest | undefined,
  ): DeviceRefusal | null => {
    const ip = fromAddress(req, deps.network)
    if (ip === undefined) return null
    const verdict = limiter.check(`${path}:${ip}`)
    if (verdict.allowed) return null
    deps.logger?.warn(`Device certificate ${path} refused: rate-limited`, {
      meta: { ip, retryAfterSeconds: verdict.retryAfterSeconds },
    })
    return refusal('rate-limited', verdict.retryAfterSeconds)
  }

  const audit = async (
    action:
      | 'device-credential-enrolled'
      | 'device-credential-revoked'
      | 'device-credential-login'
      | 'device-credential-login-refused',
    userId: string | undefined,
    req: TrpcRequest | undefined,
    detail: Record<string, string | number | boolean>,
  ): Promise<void> => {
    const ip = fromAddress(req, deps.network)
    try {
      await internal().audit.record({
        action,
        ...(userId !== undefined ? { userId } : {}),
        ...(ip !== undefined ? { ip } : {}),
        detail,
      })
    } catch (error: unknown) {
      deps.logger?.warn('Device credential audit write failed', {
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  const assertPerson = (user: { readonly userDelegated?: boolean }): void => {
    if (user.userDelegated !== true) {
      throw trpcUserError(
        'FORBIDDEN',
        'auth.session-required',
        undefined,
        'Requires a signed-in user session',
      )
    }
  }

  const selfLimit = (userId: string, path: string): void => {
    const verdict = deps.selfLimiter.check(`${path}:${userId}`)
    if (!verdict.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Too many attempts — retry in ${verdict.retryAfterSeconds}s`,
      })
    }
  }

  return {
    /** PUBLIC — redeem a QR enrollment code with the device's PUBLIC key; answers the certificate. */
    completeEnrollment: deps.publicProcedure
      .input(CompleteEnrollmentInputSchema)
      .output(CompleteEnrollmentResultSchema)
      .mutation(async ({ input, ctx }) => {
        const slow = limited(deps.credentialLimiter, 'completeEnrollment', ctx.req)
        if (slow !== null) return slow
        const issued = await internal().deviceCredentials.completeEnrollment(input)
        if (!issued.ok) return refusal(toWireReason(issued.reason))
        await audit('device-credential-enrolled', issued.userId, ctx.req, {
          credentialId: issued.credentialId,
          via: 'qr',
        })
        return {
          ok: true as const,
          credentialId: issued.credentialId,
          certPem: issued.certPem,
          chainPem: issued.chainPem,
          notAfter: issued.notAfter,
          user: { id: issued.userId, username: issued.username },
        }
      }),

    /** PUBLIC — a single-use nonce (60 s), bound to the hub origin this request is entitled to. */
    getDeviceChallenge: deps.publicProcedure
      .input(z.void())
      .output(DeviceChallengeResultSchema)
      .mutation(async ({ ctx }) => {
        const slow = limited(deps.ceremonyLimiter, 'getDeviceChallenge', ctx.req)
        if (slow !== null) return slow
        // Nonces are bounded per client address. A request whose address cannot be resolved
        // would share one partition with every other such request, so it gets no nonce.
        const partition = fromAddress(ctx.req, deps.network)
        if (partition === undefined) {
          deps.logger?.warn('Device challenge refused: the client address could not be resolved')
          return refusal('unavailable')
        }
        const origin = await deps.resolveOrigin(ctx.req)
        if (origin === null) return refusal('unavailable')
        const { nonce, expiresAt } = internal().deviceCredentials.issueNonce(origin, partition)
        return { ok: true as const, nonce, origin, expiresAt, signature: DEVICE_CERT_SIGNATURE }
      }),

    /**
     * PUBLIC — sign in with the device certificate: chain to the device CA, not
     * expired, not revoked, a valid signature over `login` + origin + nonce.
     * Opens the SAME session a password login opens, carrying the credential id.
     */
    loginWithDeviceCertificate: deps.publicProcedure
      .input(DeviceProofInputSchema.extend({ refreshable: z.boolean().optional() }))
      .output(DeviceLoginResultSchema)
      .mutation(async ({ input, ctx }) => {
        const slow = limited(deps.credentialLimiter, 'loginWithDeviceCertificate', ctx.req)
        if (slow !== null) return slow
        const from = fromAddress(ctx.req, deps.network)
        const checked = await internal().deviceCredentials.authenticate({
          certPem: input.certPem,
          nonce: input.nonce,
          signature: input.signature,
          purpose: 'login',
          ...(from !== undefined ? { from } : {}),
        })
        if (!checked.ok) {
          await audit('device-credential-login-refused', undefined, ctx.req, {
            reason: checked.reason,
          })
          return refusal(toWireReason(checked.reason))
        }
        const { credential } = checked
        try {
          const session = await deps.minter.mintForUserId(credential.userId, {
            ...deps.issueFor(ctx.req, 'device-certificate', input.refreshable ?? true),
            method: 'device-certificate',
            credentialId: credential.id,
          })
          await audit('device-credential-login', credential.userId, ctx.req, {
            credentialId: credential.id,
          })
          return {
            ok: true as const,
            token: session.token,
            user: session.user,
            ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
            ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
            ...(session.sessionExpiresAt !== undefined
              ? { sessionExpiresAt: session.sessionExpiresAt }
              : {}),
            ...(session.refreshToken !== undefined ? { refreshToken: session.refreshToken } : {}),
            credentialId: credential.id,
            certNotAfter: credential.expiresAt,
          }
        } catch (error: unknown) {
          if (error instanceof SessionUserGoneError) {
            deps.logger?.warn('Device certificate login refused: user-gone', {
              tags: { credentialId: credential.id, userId: credential.userId },
            })
            return refusal('user-gone')
          }
          throw error
        }
      }),

    /** PUBLIC — a new leaf for the SAME public key, while the certificate is valid and not revoked. */
    renewDeviceCertificate: deps.publicProcedure
      .input(DeviceProofInputSchema)
      .output(RenewDeviceCertificateResultSchema)
      .mutation(async ({ input, ctx }) => {
        const slow = limited(deps.credentialLimiter, 'renewDeviceCertificate', ctx.req)
        if (slow !== null) return slow
        const checked = await internal().deviceCredentials.authenticate({
          certPem: input.certPem,
          nonce: input.nonce,
          signature: input.signature,
          purpose: 'renew',
        })
        if (!checked.ok) return refusal(toWireReason(checked.reason))
        const renewed = await internal().deviceCredentials.renew(checked.credential)
        if (!renewed.ok) return refusal(toWireReason(renewed.reason))
        return {
          ok: true as const,
          credentialId: renewed.credentialId,
          certPem: renewed.certPem,
          chainPem: renewed.chainPem,
          notAfter: renewed.notAfter,
        }
      }),

    /**
     * PUBLIC — revoke THIS credential, signed with the device key (`revoke`
     * purpose): works with no session. Ends every session the credential opened.
     */
    revokeOwnDeviceCertificate: deps.publicProcedure
      .input(DeviceProofInputSchema)
      .output(RevokeOwnDeviceCertificateResultSchema)
      .mutation(async ({ input, ctx }) => {
        const slow = limited(deps.credentialLimiter, 'revokeOwnDeviceCertificate', ctx.req)
        if (slow !== null) return slow
        const checked = await internal().deviceCredentials.authenticate({
          certPem: input.certPem,
          nonce: input.nonce,
          signature: input.signature,
          purpose: 'revoke',
        })
        if (!checked.ok) return refusal(toWireReason(checked.reason))
        const id = checked.credential.id
        await internal().deviceCredentials.revoke(id, formatDeviceRevoker({ kind: 'device' }))
        const sessionsEnded = await internal().sessions.revokeByCredential(id)
        await audit('device-credential-revoked', checked.credential.userId, ctx.req, {
          credentialId: id,
          by: 'device',
          sessionsEnded,
        })
        return { ok: true as const, credentialId: id, sessionsEnded }
      }),

    // ── Signed-in legs ───────────────────────────────────────────────

    /** The caller's own device credentials (live ones, and revoked when asked). */
    listOwnDeviceCredentials: protectedProcedure
      .input(z.object({ includeRevoked: z.boolean().optional() }).optional())
      .output(z.array(DeviceCredentialSchema))
      .query(({ ctx, input }) => {
        assertPerson(ctx.user)
        const manager = internal().deviceCredentials
        return manager
          .list({ userId: ctx.user.id, includeRevoked: input?.includeRevoked ?? false })
          .map((r) => ({
            id: r.id,
            userId: r.userId,
            username: ctx.user.username,
            deviceName: r.deviceName,
            platform: r.platform,
            enrolledVia: r.enrolledVia,
            fingerprint: r.fingerprint,
            issuedAt: r.issuedAt,
            expiresAt: r.expiresAt,
            lastUsedAt: r.lastUsedAt,
            lastUsedFrom: r.lastUsedFrom,
            revokedAt: r.revokedAt,
            revokedBy: r.revokedBy,
            status:
              r.revokedAt !== null
                ? ('revoked' as const)
                : r.expiresAt <= Date.now()
                  ? ('expired' as const)
                  : ('active' as const),
          }))
      }),

    /** Revoke one of the caller's OWN credentials by id, from a session (e.g. a lost phone). */
    revokeOwnDeviceCredential: protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .output(z.object({ revoked: z.boolean(), sessionsEnded: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        assertPerson(ctx.user)
        selfLimit(ctx.user.id, 'revokeOwnDeviceCredential')
        const record = internal().deviceCredentials.get(input.id)
        // Someone else's credential is indistinguishable from a missing one.
        if (record === undefined || record.userId !== ctx.user.id) {
          deps.logger?.warn("Own device credential revoke refused: not the caller's", {
            tags: { userId: ctx.user.id, credentialId: input.id },
          })
          return { revoked: false, sessionsEnded: 0 }
        }
        const revoked = await internal().deviceCredentials.revoke(
          input.id,
          formatDeviceRevoker({ kind: 'user', userId: ctx.user.id }),
        )
        const sessionsEnded = await internal().sessions.revokeByCredential(input.id)
        if (revoked) {
          await audit('device-credential-revoked', ctx.user.id, ctx.req, {
            credentialId: input.id,
            by: 'user',
            sessionsEnded,
          })
        }
        return { revoked, sessionsEnded }
      }),

    /** Step-up, password / passkey: turn a fresh `reauthenticate` proof into a single-use device-enroll proof. */
    deviceEnrollProofFromReauth: protectedProcedure
      .input(z.object({ reauthToken: ReauthTokenInput }))
      .output(DeviceEnrollProofSchema)
      .mutation(({ ctx, input }) => {
        assertPerson(ctx.user)
        selfLimit(ctx.user.id, 'deviceEnrollProofFromReauth')
        assertReauthenticated(deps.auth, ctx.user, input.reauthToken)
        // One reauthentication, one proof (or one step-up handoff code).
        if (!deps.enrollProofs.consumeReauth(input.reauthToken)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'This re-authentication was already used - confirm it is you again',
          })
        }
        return deps.enrollProofs.mint(ctx.user.id)
      }),

    /**
     * Step-up through the app login handoff (any web method: OIDC, passkey, …).
     * `code` is a handoff code minted with purpose `step-up` by a browser sign-in
     * of the SAME user. Opens no session and replaces none.
     */
    deviceEnrollProofFromHandoff: protectedProcedure
      .input(
        z.object({
          code: z.string().min(1).max(256),
          codeVerifier: z.string().min(1).max(256).optional(),
          state: z.string().min(1).max(256).optional(),
        }),
      )
      .output(DeviceEnrollProofSchema)
      .mutation(({ ctx, input }) => {
        assertPerson(ctx.user)
        selfLimit(ctx.user.id, 'deviceEnrollProofFromHandoff')
        const { grant, reason } = deps.handoffCodes.redeemWithReason(input.code, {
          ...(input.codeVerifier !== undefined ? { codeVerifier: input.codeVerifier } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
        })
        const wrong = grant === null || grant.purpose !== 'step-up' || grant.userId !== ctx.user.id
        if (wrong) {
          deps.logger?.warn('Step-up handoff refused', {
            tags: { userId: ctx.user.id },
            meta: {
              reason: reason ?? (grant?.purpose !== 'step-up' ? 'wrong-purpose' : 'other-user'),
            },
          })
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid, expired or mismatched step-up code — sign in again',
          })
        }
        return deps.enrollProofs.mint(ctx.user.id)
      }),

    /**
     * Enroll the CALLER's own device — no QR. Needs a signed-in person AND a
     * single-use step-up proof (a sign-in made just now, for this same user);
     * a merely refreshed session can never mint a permanent credential.
     * Hub-wide `deviceCertificates.selfEnrollment = disabled` refuses.
     */
    enrollSelf: protectedProcedure
      .input(EnrollSelfInputSchema)
      .output(CompleteEnrollmentResultSchema)
      .mutation(async ({ ctx, input }) => {
        assertPerson(ctx.user)
        selfLimit(ctx.user.id, 'enrollSelf')
        const verdict = deps.enrollProofs.consume(input.proof, ctx.user.id)
        if (verdict !== 'ok') return refusal('step-up-required')
        const issued = await internal().deviceCredentials.enrollSelf({
          userId: ctx.user.id,
          publicKeySpki: input.publicKeySpki,
          deviceName: input.deviceName,
          platform: input.platform,
        })
        if (!issued.ok) return refusal(toWireReason(issued.reason))
        await audit('device-credential-enrolled', ctx.user.id, ctx.req, {
          credentialId: issued.credentialId,
          via: 'self',
        })
        return {
          ok: true as const,
          credentialId: issued.credentialId,
          certPem: issued.certPem,
          chainPem: issued.chainPem,
          notAfter: issued.notAfter,
          user: { id: issued.userId, username: issued.username },
        }
      }),
  }
}
