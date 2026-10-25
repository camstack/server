import {
  buildDeviceSignatureMessage,
  deviceRefusalFromMessage,
  type DeviceSignaturePurpose,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newTestDevice, type TestDevice } from '../../../auth/__tests__/device-test-kit.js'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import { DeviceEnrollProofs } from '../../../auth/device-enroll-proofs.js'
import { HandoffCodeService, pkceChallenge } from '../../../core/auth/handoff-code.service.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createRateLimiter } from '../../../auth/auth-rate-limit.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

const ORIGIN = 'https://hub.example.com'
const CLIENT_REQ = { socket: { remoteAddress: '203.0.113.5' }, headers: {} }

function setup(
  strictLimits = false,
  overrides: {
    credentials?: () => {
      check: (id: string) => 'active' | 'expired' | 'revoked' | 'unknown'
    } | null
  } = {},
) {
  const users = [
    { id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw-alice-1' },
    { id: 'u-bob', username: 'bob', isAdmin: false, password: 'pw-bob-1' },
  ]
  const h = sessionHarness(users)
  const handoffs = new HandoffCodeService()
  const enrollProofs = new DeviceEnrollProofs()
  // Generous limits for the ordinary cases; the rate-limit case builds strict ones.
  const limiters = strictLimits
    ? createAuthLimiters()
    : {
        ...createAuthLimiters(),
        credential: createRateLimiter({ windowMs: 60_000, max: 10_000 }),
        ceremony: createRateLimiter({ windowMs: 60_000, max: 10_000 }),
      }
  const router = createAuthRouter(h.auth, h.registry as never, null, handoffs, undefined, null, {
    sessions: h.backing,
    limiters,
    enrollProofs,
    resolveOrigin: async () => ORIGIN,
    ...(overrides.credentials !== undefined ? { credentials: overrides.credentials } : {}),
  })
  // A real client address: a request whose address cannot be resolved is given no nonce.
  const anon = router.createCaller({ user: null, req: CLIENT_REQ as never })
  const as = (token: string) => {
    const payload = h.auth.verifyToken(token)
    const user: AuthenticatedAgent = {
      id: payload.userId ?? '',
      username: payload.username ?? '',
      isAdmin: payload.isAdmin,
      permissions: { isAdmin: payload.isAdmin, allowedProviders: '*', allowedDevices: {} },
      isApiKey: false,
      interactive: true,
      userDelegated: true,
      ...(payload.isAdmin ? { scopes: ['*'] } : {}),
      ...(payload.sid !== undefined ? { sessionId: payload.sid } : {}),
    }
    const ctx: TrpcContext = { user }
    return router.createCaller(ctx)
  }
  return { ...h, router, anon, as, handoffs, enrollProofs, limiters, users }
}

type Setup = ReturnType<typeof setup>

async function enrollByQr(s: Setup, device: TestDevice, userId = 'u-alice') {
  const { code } = s.devices.startEnrollment({
    userId,
    deviceName: 'Wife iPhone',
    createdBy: 'admin',
  })
  const done = await s.anon.completeEnrollment({
    code,
    publicKeySpki: device.spki,
    platform: 'ios',
  })
  if (!done.ok) throw new Error(`enrollment refused: ${done.reason}`)
  return done
}

async function proof(
  s: Setup,
  device: TestDevice,
  certPem: string,
  purpose: DeviceSignaturePurpose,
  signWith: TestDevice = device,
) {
  const challenge = await s.anon.getDeviceChallenge()
  if (!challenge.ok) throw new Error(`challenge refused: ${challenge.reason}`)
  const signature = await signWith.sign(
    buildDeviceSignatureMessage({ purpose, origin: challenge.origin, nonce: challenge.nonce }),
  )
  return { certPem, nonce: challenge.nonce, signature }
}

async function signIn(s: Setup, device: TestDevice, certPem: string) {
  const result = await s.anon.loginWithDeviceCertificate({
    ...(await proof(s, device, certPem, 'login')),
    refreshable: true,
  })
  if (!result.ok) throw new Error(`login refused: ${result.reason}`)
  return result
}

describe('device certificate login', () => {
  it('opens the same kind of session a password login opens, carrying the credential id', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const result = await signIn(s, device, enrolled.certPem)
    expect(result.user).toMatchObject({ id: 'u-alice', username: 'alice' })
    expect(result.refreshToken).toMatch(/^csr_/)
    const claims = s.auth.verifyToken(result.token)
    expect(claims.cid).toBe(enrolled.credentialId)
    expect(claims.sid).toBe(result.sessionId)
    expect(s.sessions.check(result.sessionId ?? '')).toMatchObject({
      state: 'active',
      session: { method: 'device-certificate', credentialId: enrolled.credentialId },
    })
  })

  it('answers each failure with a typed reason (and `definitive` only for revoked / unknown)', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const stranger = await newTestDevice()

    const bad = await s.anon.loginWithDeviceCertificate(
      await proof(s, device, enrolled.certPem, 'login', stranger),
    )
    expect(bad).toEqual({ ok: false, reason: 'bad-signature', definitive: false })

    const ok = await proof(s, device, enrolled.certPem, 'login')
    expect((await s.anon.loginWithDeviceCertificate(ok)).ok).toBe(true)
    const replay = await s.anon.loginWithDeviceCertificate(ok)
    expect(replay).toEqual({ ok: false, reason: 'nonce-invalid', definitive: false })

    // a signature made for ANOTHER origin
    const challenge = await s.anon.getDeviceChallenge()
    if (!challenge.ok) throw new Error('challenge')
    const wrongOrigin = await s.anon.loginWithDeviceCertificate({
      certPem: enrolled.certPem,
      nonce: challenge.nonce,
      signature: await device.sign(
        buildDeviceSignatureMessage({
          purpose: 'login',
          origin: 'https://evil.example.com',
          nonce: challenge.nonce,
        }),
      ),
    })
    expect(wrongOrigin).toEqual({ ok: false, reason: 'bad-signature', definitive: false })

    await s.devices.revoke(enrolled.credentialId, 'admin:root')
    const revoked = await s.anon.loginWithDeviceCertificate(
      await proof(s, device, enrolled.certPem, 'login'),
    )
    expect(revoked).toEqual({ ok: false, reason: 'revoked', definitive: true })

    await s.devices.delete(enrolled.credentialId)
    const gone = await s.anon.loginWithDeviceCertificate(
      await proof(s, device, enrolled.certPem, 'login'),
    )
    expect(gone).toEqual({ ok: false, reason: 'unknown-credential', definitive: true })
  })

  it('a certificate the device CA never issued is `invalid-certificate`', async () => {
    const s = setup()
    const other = setup()
    const device = await newTestDevice()
    const foreign = await enrollByQr(other, device)
    const refused = await s.anon.loginWithDeviceCertificate(
      await proof(s, device, foreign.certPem, 'login'),
    )
    expect(refused).toMatchObject({ ok: false, reason: 'invalid-certificate', definitive: false })
  })

  it('is rate limited per client address with a TYPED refusal', async () => {
    const s = setup(true)
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const ctx: TrpcContext = {
      user: null,
      req: { socket: { remoteAddress: '203.0.113.5' }, headers: {} } as never,
    }
    const caller = s.router.createCaller(ctx)
    const attempt = async () =>
      caller.loginWithDeviceCertificate({
        certPem: enrolled.certPem,
        nonce: 'x',
        signature: 'AAAA',
      })
    let last = await attempt()
    for (let i = 0; i < 12; i++) last = await attempt()
    expect(last).toMatchObject({ ok: false, reason: 'rate-limited', definitive: false })
  })
})

describe('revocation', () => {
  it('SECURITY: revoking the credential cuts an existing session at its next refresh', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const session = await signIn(s, device, enrolled.certPem)
    // Refreshes while the credential is live.
    const refreshed = await s.anon.refreshSession({ refreshToken: session.refreshToken ?? '' })
    // Revoke in the registry ONLY (the session sweep never runs): the refresh path itself must notice.
    await s.devices.revoke(enrolled.credentialId, 'admin:root')
    const error = await s.anon
      .refreshSession({ refreshToken: refreshed.refreshToken })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : ''
    expect(deviceRefusalFromMessage(message)).toBe('revoked')
    expect(s.sessions.check(session.sessionId ?? '').state).toBe('revoked')
  })

  it('a deleted credential row refuses a refresh as `unknown-credential`', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const session = await signIn(s, device, enrolled.certPem)
    await s.devices.revoke(enrolled.credentialId, 'admin:root')
    await s.devices.delete(enrolled.credentialId)
    const error = await s.anon
      .refreshSession({ refreshToken: session.refreshToken ?? '' })
      .catch((e: unknown) => e)
    expect(deviceRefusalFromMessage(error instanceof Error ? error.message : '')).toBe(
      'unknown-credential',
    )
  })

  it('a device-signed revoke works with no session, ends its sessions at once, and records `device`', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const session = await signIn(s, device, enrolled.certPem)
    const result = await s.anon.revokeOwnDeviceCertificate(
      await proof(s, device, enrolled.certPem, 'revoke'),
    )
    expect(result).toMatchObject({
      ok: true,
      credentialId: enrolled.credentialId,
      sessionsEnded: 1,
    })
    expect(s.devices.get(enrolled.credentialId)).toMatchObject({ revokedBy: 'device' })
    expect(s.sessions.check(session.sessionId ?? '').state).toBe('revoked')
  })

  it('a LOGIN signature cannot revoke (the purpose is signed)', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const refused = await s.anon.revokeOwnDeviceCertificate(
      await proof(s, device, enrolled.certPem, 'login'),
    )
    expect(refused).toMatchObject({ ok: false, reason: 'bad-signature' })
    expect(s.devices.check(enrolled.credentialId)).toBe('active')
  })

  it("a signed-in user revokes their OWN credential by id, never someone else's", async () => {
    const s = setup()
    const device = await newTestDevice()
    const alicePhone = await enrollByQr(s, device, 'u-alice')
    const bobPhone = await enrollByQr(s, await newTestDevice(), 'u-bob')
    const alice = s.as((await s.anon.login({ username: 'alice', password: 'pw-alice-1' })).token)
    expect(await alice.revokeOwnDeviceCredential({ id: bobPhone.credentialId })).toEqual({
      revoked: false,
      sessionsEnded: 0,
    })
    expect(s.devices.check(bobPhone.credentialId)).toBe('active')
    expect(await alice.revokeOwnDeviceCredential({ id: alicePhone.credentialId })).toMatchObject({
      revoked: true,
    })
    expect(s.devices.get(alicePhone.credentialId)).toMatchObject({ revokedBy: 'user:u-alice' })
  })
})

describe('renewal', () => {
  it('keeps the SAME public key, answers a later expiry, and the new certificate logs in', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const renewed = await s.anon.renewDeviceCertificate(
      await proof(s, device, enrolled.certPem, 'renew'),
    )
    if (!renewed.ok) throw new Error(renewed.reason)
    expect(renewed.credentialId).toBe(enrolled.credentialId)
    expect(renewed.certPem).not.toBe(enrolled.certPem)
    expect(renewed.notAfter).toBeGreaterThanOrEqual(enrolled.notAfter)
    expect(s.devices.get(enrolled.credentialId)?.publicKey).toBe(device.spki)
    await signIn(s, device, renewed.certPem)
  })

  it('refuses a renewal of a revoked credential with the typed reason', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    await s.devices.revoke(enrolled.credentialId, 'admin:root')
    expect(
      await s.anon.renewDeviceCertificate(await proof(s, device, enrolled.certPem, 'renew')),
    ).toEqual({ ok: false, reason: 'revoked', definitive: true })
  })
})

describe('enrollSelf', () => {
  async function signedInAlice(s: Setup) {
    return s.as(
      (await s.anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })).token,
    )
  }
  async function stepUpProof(alice: Awaited<ReturnType<typeof signedInAlice>>) {
    const { reauthToken } = await alice.reauthenticate({ password: 'pw-alice-1' })
    return alice.deviceEnrollProofFromReauth({ reauthToken })
  }

  it('SECURITY: a signed-in session WITHOUT a step-up proof can never mint a credential', async () => {
    const s = setup()
    const alice = await signedInAlice(s)
    const device = await newTestDevice()
    const refused = await alice.enrollSelf({
      proof: 'cdp_not-a-real-proof',
      publicKeySpki: device.spki,
      deviceName: 'My phone',
      platform: 'ios',
    })
    expect(refused).toMatchObject({ ok: false, reason: 'step-up-required' })
    expect(s.devices.list({ includeRevoked: true })).toHaveLength(0)
  })

  it("with a fresh step-up proof it enrolls the caller's OWN device, once", async () => {
    const s = setup()
    const alice = await signedInAlice(s)
    const device = await newTestDevice()
    const { proof: p } = await stepUpProof(alice)
    const input = {
      proof: p,
      publicKeySpki: device.spki,
      deviceName: 'My phone',
      platform: 'ios' as const,
    }
    const issued = await alice.enrollSelf(input)
    if (!issued.ok) throw new Error(issued.reason)
    expect(issued.user.id).toBe('u-alice')
    expect(s.devices.get(issued.credentialId)).toMatchObject({
      enrolledVia: 'self',
      userId: 'u-alice',
    })
    // The proof is consumed: the same proof mints nothing a second time.
    expect(
      await alice.enrollSelf({ ...input, publicKeySpki: (await newTestDevice()).spki }),
    ).toMatchObject({
      ok: false,
      reason: 'step-up-required',
    })
    // And the existing session was neither replaced nor rotated.
    expect((await alice.me())?.id).toBe('u-alice')
  })

  it('a proof minted for ANOTHER user is refused', async () => {
    const s = setup()
    const alice = await signedInAlice(s)
    const bobProof = s.enrollProofs.mint('u-bob')
    const device = await newTestDevice()
    expect(
      await alice.enrollSelf({
        proof: bobProof.proof,
        publicKeySpki: device.spki,
        deviceName: 'p',
        platform: 'ios',
      }),
    ).toMatchObject({ ok: false, reason: 'step-up-required' })
  })

  it('an expired proof is refused', async () => {
    let now = 1_000_000
    const s = setup()
    const clock = new DeviceEnrollProofs(() => now)
    const minted = clock.mint('u-alice')
    now += 6 * 60_000
    expect(clock.consume(minted.proof, 'u-alice')).toBe('expired')
    expect(s.enrollProofs).toBeDefined()
  })

  it('is refused with a clear reason while the hub setting is `disabled`', async () => {
    const s = setup()
    s.deviceState.selfEnrollment = false
    const alice = await signedInAlice(s)
    const device = await newTestDevice()
    const { proof: p } = await stepUpProof(alice)
    expect(
      await alice.enrollSelf({
        proof: p,
        publicKeySpki: device.spki,
        deviceName: 'p',
        platform: 'ios',
      }),
    ).toMatchObject({ ok: false, reason: 'self-enrollment-disabled' })
  })

  it('step-up through the app handoff (any web method): a `step-up` code of the SAME user yields a proof', async () => {
    const s = setup()
    const alice = await signedInAlice(s)
    const verifier = 'v'.repeat(48)
    const { code } = s.handoffs.create('u-alice', {
      purpose: 'step-up',
      codeChallenge: pkceChallenge(verifier),
      state: 'st-1',
    })
    const got = await alice.deviceEnrollProofFromHandoff({
      code,
      codeVerifier: verifier,
      state: 'st-1',
    })
    expect(got.proof).toMatch(/^cdp_/)
  })

  it('step-up handoff refusals: wrong verifier, other user, wrong purpose, reuse', async () => {
    const s = setup()
    const alice = await signedInAlice(s)
    const verifier = 'v'.repeat(48)
    const challenge = pkceChallenge(verifier)
    const wrongVerifier = s.handoffs.create('u-alice', {
      purpose: 'step-up',
      codeChallenge: challenge,
    })
    await expect(
      alice.deviceEnrollProofFromHandoff({
        code: wrongVerifier.code,
        codeVerifier: 'x'.repeat(48),
      }),
    ).rejects.toThrow()
    const otherUser = s.handoffs.create('u-bob', { purpose: 'step-up' })
    await expect(alice.deviceEnrollProofFromHandoff({ code: otherUser.code })).rejects.toThrow()
    const login = s.handoffs.create('u-alice', { purpose: 'new-session' })
    await expect(alice.deviceEnrollProofFromHandoff({ code: login.code })).rejects.toThrow()
    const once = s.handoffs.create('u-alice', { purpose: 'step-up' })
    await alice.deviceEnrollProofFromHandoff({ code: once.code })
    await expect(alice.deviceEnrollProofFromHandoff({ code: once.code })).rejects.toThrow()
  })

  it('a step-up code is NOT a login code: redeemHandoffCode refuses it', async () => {
    const s = setup()
    const { code } = s.handoffs.create('u-alice', { purpose: 'step-up' })
    await expect(s.anon.redeemHandoffCode({ code })).rejects.toThrow()
  })
})

describe('app login handoff PKCE', () => {
  it('a code minted with a challenge redeems only with its verifier, once', async () => {
    const s = setup()
    const alice = s.as((await s.anon.login({ username: 'alice', password: 'pw-alice-1' })).token)
    const verifier = 'p'.repeat(64)
    const { code } = await alice.createHandoffCode({
      purpose: 'new-session',
      codeChallenge: pkceChallenge(verifier),
      state: 'state-1',
    })
    await expect(s.anon.redeemHandoffCode({ code, state: 'state-1' })).rejects.toThrow()
    // burned by the failed attempt:
    await expect(
      s.anon.redeemHandoffCode({ code, codeVerifier: verifier, state: 'state-1' }),
    ).rejects.toThrow()
    const second = await alice.createHandoffCode({
      purpose: 'new-session',
      codeChallenge: pkceChallenge(verifier),
      state: 'state-1',
    })
    await expect(
      s.anon.redeemHandoffCode({ code: second.code, codeVerifier: verifier, state: 'other' }),
    ).rejects.toThrow()
    const third = await alice.createHandoffCode({
      purpose: 'new-session',
      codeChallenge: pkceChallenge(verifier),
      state: 'state-1',
    })
    const session = await s.anon.redeemHandoffCode({
      code: third.code,
      codeVerifier: verifier,
      state: 'state-1',
    })
    expect(session.user.id).toBe('u-alice')
    await expect(
      s.anon.redeemHandoffCode({ code: third.code, codeVerifier: verifier, state: 'state-1' }),
    ).rejects.toThrow()
  })
})

describe('listLoginMethods', () => {
  it('carries the device-certificate arm', async () => {
    const s = setup()
    const methods = await s.anon.listLoginMethods()
    const arm = methods.find((m) => m.kind === 'device-certificate')
    expect(arm).toMatchObject({
      kind: 'device-certificate',
      stage: 'primary',
      challengePath: 'auth.getDeviceChallenge',
      loginPath: 'auth.loginWithDeviceCertificate',
      signature: 'ecdsa-p256-sha256',
      // The app executes it itself, silently (D858).
      app: { kind: 'native' },
    })
  })
})

const CHALLENGE = pkceChallenge('c'.repeat(64))

describe('SECURITY: a step-up needs an authentication that just happened', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('HIGH: a fresh sign-in may start ONE step-up, and the chain reaches enrollSelf', async () => {
    const s = setup()
    const alice = s.as((await s.anon.login({ username: 'alice', password: 'pw-alice-1' })).token)
    const { code } = await alice.createHandoffCode({
      purpose: 'step-up',
      codeChallenge: CHALLENGE,
      state: 'st',
    })
    const { proof } = await alice.deviceEnrollProofFromHandoff({
      code,
      codeVerifier: 'c'.repeat(64),
      state: 'st',
    })
    const device = await newTestDevice()
    const issued = await alice.enrollSelf({
      proof,
      publicKeySpki: device.spki,
      deviceName: 'p',
      platform: 'ios',
    })
    expect(issued.ok).toBe(true)
    // The same sign-in cannot start a second step-up.
    await expect(
      alice.createHandoffCode({ purpose: 'step-up', codeChallenge: CHALLENGE, state: 'st2' }),
    ).rejects.toThrow(/Sign in again/)
  })

  it('HIGH: an OLD session (stolen, or just long-lived) cannot mint a step-up code, so no credential', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = setup()
    const alice = s.as((await s.anon.login({ username: 'alice', password: 'pw-alice-1' })).token)
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await expect(
      alice.createHandoffCode({ purpose: 'step-up', codeChallenge: CHALLENGE, state: 'st' }),
    ).rejects.toThrow(/too old/)
    expect(s.devices.list({ includeRevoked: true })).toHaveLength(0)
  })

  it('HIGH: a session born of a handoff is not an authentication - the laundering chain is refused', async () => {
    const s = setup()
    const alice = s.as((await s.anon.login({ username: 'alice', password: 'pw-alice-1' })).token)
    const { code } = await alice.createHandoffCode({
      purpose: 'new-session',
      codeChallenge: CHALLENGE,
      state: 'st',
    })
    const child = await s.anon.redeemHandoffCode({
      code,
      codeVerifier: 'c'.repeat(64),
      state: 'st',
      refreshable: true,
    })
    const childCaller = s.as(child.token)
    await expect(
      childCaller.createHandoffCode({ purpose: 'step-up', codeChallenge: CHALLENGE, state: 's2' }),
    ).rejects.toThrow(/not opened by a sign-in/)
  })

  it('a single-use reauth token also authorises a step-up on an old session - once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = setup()
    const alice = s.as((await s.anon.login({ username: 'alice', password: 'pw-alice-1' })).token)
    const { reauthToken } = await alice.reauthenticate({ password: 'pw-alice-1' })
    vi.setSystemTime(Date.now() + 3 * 60_000)
    await alice.createHandoffCode({
      purpose: 'step-up',
      codeChallenge: CHALLENGE,
      state: 'st',
      reauthToken,
    })
    await expect(
      alice.createHandoffCode({
        purpose: 'step-up',
        codeChallenge: CHALLENGE,
        state: 'st',
        reauthToken,
      }),
    ).rejects.toThrow(/already used/)
  })

  it('LOW: one reauth token mints ONE proof', async () => {
    const s = setup()
    const alice = s.as((await s.anon.login({ username: 'alice', password: 'pw-alice-1' })).token)
    const { reauthToken } = await alice.reauthenticate({ password: 'pw-alice-1' })
    await alice.deviceEnrollProofFromReauth({ reauthToken })
    await expect(alice.deviceEnrollProofFromReauth({ reauthToken })).rejects.toThrow(/already used/)
  })
})

describe('MEDIUM: PKCE and state are mandatory for an app-callback code', () => {
  it('new-session and step-up are refused without a challenge or a state; renew stays legacy', async () => {
    const s = setup()
    const alice = s.as((await s.anon.login({ username: 'alice', password: 'pw-alice-1' })).token)
    await expect(alice.createHandoffCode({ purpose: 'new-session' })).rejects.toThrow(
      /codeChallenge/,
    )
    await expect(
      alice.createHandoffCode({ purpose: 'new-session', codeChallenge: CHALLENGE }),
    ).rejects.toThrow(/state/)
    await expect(alice.createHandoffCode({ purpose: 'step-up' })).rejects.toThrow(/codeChallenge/)
    expect((await alice.createHandoffCode({ purpose: 'renew' })).code).toMatch(/^chc_/)
  })
})

describe('MEDIUM: a session minted from a credential session dies with the credential', () => {
  it('revoking the credential refuses the refresh of a handoff-born child session', async () => {
    const s = setup()
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const session = await signIn(s, device, enrolled.certPem)
    const parent = s.as(session.token)
    const { code } = await parent.createHandoffCode({
      purpose: 'new-session',
      codeChallenge: CHALLENGE,
      state: 'st',
    })
    const child = await s.anon.redeemHandoffCode({
      code,
      codeVerifier: 'c'.repeat(64),
      state: 'st',
      refreshable: true,
    })
    expect(s.sessions.check(child.sessionId ?? '')).toMatchObject({
      state: 'active',
      session: { credentialId: enrolled.credentialId },
    })
    await s.devices.revoke(enrolled.credentialId, 'admin:root')
    const error = await s.anon
      .refreshSession({ refreshToken: child.refreshToken ?? '' })
      .catch((e: unknown) => e)
    expect(deviceRefusalFromMessage(error instanceof Error ? error.message : '')).toBe('revoked')
  })
})

describe('LOW: the credential is judged BEFORE the refresh token is spent', () => {
  it('a transient `unavailable` leaves the refresh token valid (no refresh-reuse revocation)', async () => {
    let available = false
    let delegate: { check: (id: string) => 'active' | 'expired' | 'revoked' | 'unknown' } | null =
      null
    const s = setup(false, { credentials: () => (available ? delegate : null) })
    delegate = s.devices
    const device = await newTestDevice()
    const enrolled = await enrollByQr(s, device)
    const session = await signIn(s, device, enrolled.certPem)
    const first = await s.anon
      .refreshSession({ refreshToken: session.refreshToken ?? '' })
      .catch((e: unknown) => e)
    expect(deviceRefusalFromMessage(first instanceof Error ? first.message : '')).toBe(
      'unavailable',
    )
    available = true
    // The SAME token still works once the registry answers.
    const retry = await s.anon.refreshSession({ refreshToken: session.refreshToken ?? '' })
    expect(retry.sessionId).toBe(session.sessionId)
    expect(s.sessions.check(session.sessionId ?? '').state).toBe('active')
  })
})

describe('partials from the second review', () => {
  it('SECURITY: a challenge is refused (typed) when the client address cannot be resolved - no shared nonce partition', async () => {
    const s = setup()
    const noAddress = s.router.createCaller({ user: null })
    expect(await noAddress.getDeviceChallenge()).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('SECURITY: a `renew` handoff code with no session behind it opens NO session', async () => {
    const s = setup()
    const { code } = s.handoffs.create('u-alice', { purpose: 'renew' }) // no sessionId
    await expect(s.anon.redeemHandoffCode({ code, refreshable: true })).rejects.toThrow(
      /Invalid or expired/,
    )
    expect(s.sessions.listForUser('u-alice')).toHaveLength(0)
  })

  it('SECURITY: "once per sign-in" survives a restart - a sign-in that predates this process may not start a step-up', () => {
    let now = 1_000_000
    const proofs = new DeviceEnrollProofs(() => now)
    now += 10
    expect(proofs.claimFreshSession('s-old', now - 5_000)).toBe(false) // opened before boot
    expect(proofs.claimFreshSession('s-new', now + 1)).toBe(true)
    expect(proofs.claimFreshSession('s-new', now + 1)).toBe(false) // and only once
  })
})
