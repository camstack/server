/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- test harness mocks values across typed boundaries (simplewebauthn stubs, AddonContext stubs). Pre-existing pattern in this project (mirrors the oidc spec). */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `@simplewebauthn/server` is mocked at the module level so tests drive
// `generateAuthenticationOptions` / `verifyAuthenticationResponse`
// directly — real assertion verification needs an authenticator-signed
// payload we can't mint in a unit test. Challenge bookkeeping (single
// use, TTL, flow-kind isolation) is the addon's OWN logic and runs for
// real. Mirrors the `jose` mocking pattern in the oidc addon spec.
const swanMock = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}))
vi.mock('@simplewebauthn/server', () => swanMock)

import {
  type AddonContext,
  AUTOMATIC_HUB_ADDRESS_FLAGS,
  type ConnectionEndpoint,
  type IScopedLogger,
  type IUserPasskeysProvider,
  type RecordsAccess,
  resolveHubAddressRoles,
} from '@camstack/types'
// Import AFTER the mock declaration so the addon picks up our stub.
import { AuthWebauthnAddon } from '../auth-webauthn.addon.js'
import {
  makeWebauthnTestRecords,
  passkeyCounter,
  seedTestPasskey,
} from './webauthn-test-records.js'

// ---------------------------------------------------------------------------
// Test harness — minimal AddonContext stub + in-memory settings-store rows
// ---------------------------------------------------------------------------

interface StoredRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

interface SettingsStoreMock {
  readonly rows: Map<string, StoredRow>
  readonly declareCollection: { mutate: ReturnType<typeof vi.fn> }
  readonly insert: { mutate: ReturnType<typeof vi.fn> }
  readonly query: { query: ReturnType<typeof vi.fn> }
  readonly update: { mutate: ReturnType<typeof vi.fn> }
  readonly delete: { mutate: ReturnType<typeof vi.fn> }
}

/**
 * In-memory stand-in for the settings-store's structured-table mode —
 * just enough of the `SettingsStoreClient` surface for `PasskeyStore`
 * (declareCollection / insert / query-by-where / update / delete).
 */
function makeSettingsStore(): SettingsStoreMock {
  const rows = new Map<string, StoredRow>()
  return {
    rows,
    declareCollection: { mutate: vi.fn(async () => undefined) },
    insert: {
      mutate: vi.fn(async (input: { record: StoredRow }) => {
        rows.set(input.record.id, input.record)
      }),
    },
    query: {
      query: vi.fn(async (input: { filter?: { where?: Record<string, unknown> } }) => {
        const where = input.filter?.where ?? {}
        return [...rows.values()].filter((r) =>
          Object.entries(where).every(([k, v]) => r.data[k] === v),
        )
      }),
    },
    update: {
      mutate: vi.fn(async (input: { id: string; data: Record<string, unknown> }) => {
        rows.set(input.id, { id: input.id, data: input.data })
      }),
    },
    delete: { mutate: vi.fn(async (input: { key: string }) => rows.delete(input.key)) },
  }
}

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

interface TestCtxOptions {
  readonly config?: Record<string, unknown>
  readonly settingsStore?: SettingsStoreMock
  /** Shared records world — same instance survives a re-boot in one spec. */
  readonly records?: RecordsAccess
  /** The hub's `local-network` palette; absent = the cap is unreachable. */
  readonly endpoints?: readonly ConnectionEndpoint[]
}

function makeCtx(opts: TestCtxOptions = {}): { ctx: AddonContext; store: SettingsStoreMock } {
  const store = opts.settingsStore ?? makeSettingsStore()
  const settings = {
    readAddonStore: vi.fn(async () => opts.config ?? {}),
    writeAddonStore: vi.fn(async () => undefined),
    readDeviceStore: vi.fn(async () => ({})),
    writeDeviceStore: vi.fn(async () => undefined),
    getSection: vi.fn(async () => ({})),
    setSection: vi.fn(async () => undefined),
  }
  const ctx = {
    id: 'auth-webauthn',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: '/tmp/webauthn-test',
    nodeDataDir: '/tmp',
    kernel: { localNodeId: 'hub', devices: {} as never },
    settings,
    api: {
      settingsStore: store,
      ...(opts.endpoints === undefined
        ? {}
        : {
            localNetwork: {
              getAddresses: {
                query: vi.fn(async () => ({
                  rows: [],
                  roles: resolveHubAddressRoles(
                    opts.endpoints ?? [],
                    opts.endpoints ?? [],
                    AUTOMATIC_HUB_ADDRESS_FLAGS,
                  ),
                  appLinkHub: null,
                })),
              },
            },
          }),
    } as never,
    capabilities: {
      get: vi.fn(() => undefined),
      getCollection: vi.fn(() => undefined),
      getCollectionEntries: vi.fn(() => undefined),
    },
    deps: {} as never,
    useCapability: vi.fn(),
    acquireCapability: vi.fn(),
    onCapabilityStateChange: vi.fn(),
  } as unknown as AddonContext
  return { ctx, store }
}

async function bootAddon(opts: TestCtxOptions = {}): Promise<{
  addon: AuthWebauthnAddon
  provider: IUserPasskeysProvider
  store: SettingsStoreMock
  records: RecordsAccess
}> {
  const records = opts.records ?? (await makeWebauthnTestRecords())
  const { ctx, store } = makeCtx(opts)
  const addon = new AuthWebauthnAddon()
  const result = await addon.initialize({ ...ctx, records })
  const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = Array.isArray(
    result,
  )
    ? result
    : ((result as any)?.providers ?? [])
  const registration = list.find((r) => r.capability.name === 'user-passkeys')
  if (!registration) throw new Error('user-passkeys provider not registered')
  return {
    addon,
    provider: registration.provider as IUserPasskeysProvider,
    store,
    records,
  }
}

async function initializeAuthAddon(opts: TestCtxOptions = {}): Promise<{
  ctx: AddonContext
  store: SettingsStoreMock
  records: RecordsAccess
  addon: AuthWebauthnAddon
  result: unknown
}> {
  const records = opts.records ?? (await makeWebauthnTestRecords())
  const { ctx, store } = makeCtx(opts)
  const ctxWithRecords = { ...ctx, records }
  const addon = new AuthWebauthnAddon()
  const result = await addon.initialize(ctxWithRecords)
  return { ctx: ctxWithRecords, store, records, addon, result }
}

/**
 * Build a browser `AuthenticationResponseJSON`-shaped record whose
 * `clientDataJSON` carries the given challenge — the addon decodes it to
 * find the matching pending challenge.
 */
function makeAssertion(challenge: string, credentialId = 'cred-1'): Record<string, unknown> {
  const clientData = { type: 'webauthn.get', challenge, origin: 'http://localhost:4443' }
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString('base64url'),
      authenticatorData: 'stub',
      signature: 'stub',
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  swanMock.generateAuthenticationOptions.mockReset()
  swanMock.verifyAuthenticationResponse.mockReset()
  swanMock.generateAuthenticationOptions.mockImplementation(async (opts: unknown) => ({
    challenge: 'disc-chal-1',
    rpId: 'localhost',
    allowCredentials: (opts as { allowCredentials?: unknown[] }).allowCredentials ?? [],
    userVerification: (opts as { userVerification?: string }).userVerification,
  }))
  swanMock.verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 6 },
  })
})

// ---------------------------------------------------------------------------
// beginDiscoverableAuthentication
// ---------------------------------------------------------------------------

describe('beginDiscoverableAuthentication', () => {
  it('issues options with EMPTY allowCredentials and required user verification', async () => {
    const { provider } = await bootAddon()
    const result = await provider.beginDiscoverableAuthentication({})

    expect(result.optionsJSON['challenge']).toBe('disc-chal-1')
    expect(swanMock.generateAuthenticationOptions).toHaveBeenCalledTimes(1)
    const args = swanMock.generateAuthenticationOptions.mock.calls[0]![0] as {
      allowCredentials?: unknown[]
      userVerification?: string
    }
    // Discoverable flow: the browser must offer EVERY resident passkey —
    // never a user-scoped allow-list.
    expect(args.allowCredentials ?? []).toEqual([])
    // The passkey is the ONLY factor here — UV is mandatory.
    expect(args.userVerification).toBe('required')
  })

  it('issues an unbound challenge even when passkeys exist (no user leak)', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records)
    const { provider } = await bootAddon({ records })
    await provider.beginDiscoverableAuthentication({})
    const args = swanMock.generateAuthenticationOptions.mock.calls[0]![0] as {
      allowCredentials?: unknown[]
    }
    expect(args.allowCredentials ?? []).toEqual([])
  })
})

describe('the pending challenge map is bounded (D858)', () => {
  let seq = 0
  beforeEach(() => {
    seq = 0
    swanMock.generateAuthenticationOptions.mockImplementation(async () => ({
      challenge: `flood-${(seq += 1)}`,
    }))
  })

  it('refuses a new ceremony when full of LIVE challenges, and never evicts a live one', async () => {
    const { addon, provider } = await bootAddon()
    for (let i = 0; i < 1_000; i += 1) await provider.beginDiscoverableAuthentication({})
    await expect(provider.beginDiscoverableAuthentication({})).rejects.toThrow(/Too many pending/)
    // Nothing live was evicted to make room, and the first challenge is still there.
    const pending = (addon as any).pending as Map<string, unknown>
    expect(pending.size).toBe(1_000)
    expect(pending.has('flood-1')).toBe(true)
  })

  it('makes room by dropping EXPIRED challenges first', async () => {
    const { provider } = await bootAddon()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    for (let i = 0; i < 1_000; i += 1) await provider.beginDiscoverableAuthentication({})
    now.mockReturnValue(1_000_000 + 6 * 60_000)
    await expect(provider.beginDiscoverableAuthentication({})).resolves.toBeDefined()
    now.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// finishDiscoverableAuthentication
// ---------------------------------------------------------------------------

describe('finishDiscoverableAuthentication', () => {
  it('verifies the assertion and returns the credential-owning userId', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records, { userId: 'u-42' })
    const { provider } = await bootAddon({ records })

    await provider.beginDiscoverableAuthentication({})
    const result = await provider.finishDiscoverableAuthentication({
      response: makeAssertion('disc-chal-1'),
    })

    expect(result).toEqual({ verified: true, userId: 'u-42' })
    // The stored credential's key material fed the verifier.
    const verifyArgs = swanMock.verifyAuthenticationResponse.mock.calls[0]![0] as {
      expectedChallenge: string
      credential: { id: string; counter: number }
      requireUserVerification?: boolean
    }
    expect(verifyArgs.expectedChallenge).toBe('disc-chal-1')
    expect(verifyArgs.credential.id).toBe('cred-1')
    expect(verifyArgs.credential.counter).toBe(5)
    expect(verifyArgs.requireUserVerification).toBe(true)
    // Counter bump persisted (cloned-authenticator detection).
    expect(await passkeyCounter(records, 'cred-1')).toBe(6)
  })

  it('rejects a challenge the server never issued', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records)
    const { provider } = await bootAddon({ records })
    const result = await provider.finishDiscoverableAuthentication({
      response: makeAssertion('never-issued'),
    })
    expect(result).toEqual({ verified: false, userId: null })
    expect(swanMock.verifyAuthenticationResponse).not.toHaveBeenCalled()
  })

  it('is single-use — replaying the same assertion fails the second time', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records)
    const { provider } = await bootAddon({ records })
    await provider.beginDiscoverableAuthentication({})
    const assertion = makeAssertion('disc-chal-1')

    const first = await provider.finishDiscoverableAuthentication({ response: assertion })
    expect(first.verified).toBe(true)
    const replay = await provider.finishDiscoverableAuthentication({ response: assertion })
    expect(replay).toEqual({ verified: false, userId: null })
    expect(swanMock.verifyAuthenticationResponse).toHaveBeenCalledTimes(1)
  })

  it('rejects a challenge minted for the SECOND-FACTOR flow (kind isolation)', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records)
    const { provider } = await bootAddon({ records })
    // Mint a strict-user (second-factor) authentication challenge …
    swanMock.generateAuthenticationOptions.mockResolvedValueOnce({ challenge: '2fa-chal' })
    await provider.beginAuthentication({ userId: 'u-1' })
    // … and try to spend it on the discoverable finish leg.
    const result = await provider.finishDiscoverableAuthentication({
      response: makeAssertion('2fa-chal'),
    })
    expect(result).toEqual({ verified: false, userId: null })
    expect(swanMock.verifyAuthenticationResponse).not.toHaveBeenCalled()
  })

  it('rejects an expired challenge (TTL honored on the finish leg)', async () => {
    vi.useFakeTimers()
    try {
      const records = await makeWebauthnTestRecords()
      await seedTestPasskey(records)
      const { provider } = await bootAddon({ records })
      await provider.beginDiscoverableAuthentication({})
      // Default TTL is 300s — jump past it.
      vi.advanceTimersByTime(301_000)
      const result = await provider.finishDiscoverableAuthentication({
        response: makeAssertion('disc-chal-1'),
      })
      expect(result).toEqual({ verified: false, userId: null })
      expect(swanMock.verifyAuthenticationResponse).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an assertion for an unknown credential id', async () => {
    const { provider } = await bootAddon() // no passkeys stored at all
    await provider.beginDiscoverableAuthentication({})
    const result = await provider.finishDiscoverableAuthentication({
      response: makeAssertion('disc-chal-1', 'ghost-cred'),
    })
    expect(result).toEqual({ verified: false, userId: null })
    expect(swanMock.verifyAuthenticationResponse).not.toHaveBeenCalled()
  })

  it('returns verified:false when the verifier throws (counter regression / bad signature)', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records)
    const { provider } = await bootAddon({ records })
    await provider.beginDiscoverableAuthentication({})
    swanMock.verifyAuthenticationResponse.mockRejectedValueOnce(
      new Error('Response counter value 3 was lower than expected 5'),
    )
    const result = await provider.finishDiscoverableAuthentication({
      response: makeAssertion('disc-chal-1'),
    })
    expect(result).toEqual({ verified: false, userId: null })
    // No counter mutation on a failed verification.
    expect(await passkeyCounter(records, 'cred-1')).toBe(5)
  })

  it('returns verified:false when the verifier reports an unverified assertion', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records)
    const { provider } = await bootAddon({ records })
    await provider.beginDiscoverableAuthentication({})
    swanMock.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false })
    const result = await provider.finishDiscoverableAuthentication({
      response: makeAssertion('disc-chal-1'),
    })
    expect(result).toEqual({ verified: false, userId: null })
  })
})

// ---------------------------------------------------------------------------
// login-method contribution — the primary-stage usernameless entry
// ---------------------------------------------------------------------------

describe('login-method contribution', () => {
  it('contributes BOTH a primary (usernameless) and a second-factor passkey entry', async () => {
    const { result } = await initializeAuthAddon()
    const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = Array.isArray(
      result,
    )
      ? result
      : ((result as any)?.providers ?? [])
    const loginMethodReg = list.find((r) => r.capability.name === 'login-method')
    expect(loginMethodReg).toBeDefined()
    const methods = await (
      loginMethodReg!.provider as { getLoginMethods: () => Promise<ReadonlyArray<any>> }
    ).getLoginMethods()

    const stages = methods.map((m) => m.stage).sort()
    expect(stages).toEqual(['primary', 'second-factor'])
    const primary = methods.find((m) => m.stage === 'primary')
    const secondFactor = methods.find((m) => m.stage === 'second-factor')
    expect(primary.id).not.toBe(secondFactor.id)
  })

  it('contributes both entries as the declarative kind:"passkey" arm, stamped with the effective rpId/origin', async () => {
    const { result } = await initializeAuthAddon({
      config: { rpID: 'cams.example.com', origin: 'https://cams.example.com' },
    })
    const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = Array.isArray(
      result,
    )
      ? result
      : ((result as any)?.providers ?? [])
    const loginMethodReg = list.find((r) => r.capability.name === 'login-method')
    const methods = await (
      loginMethodReg!.provider as { getLoginMethods: () => Promise<ReadonlyArray<any>> }
    ).getLoginMethods()

    expect(methods).toHaveLength(2)
    for (const m of methods) {
      expect(m.kind).toBe('passkey')
      expect(m.rpId).toBe('cams.example.com')
      expect(m.origin).toBe('https://cams.example.com')
    }
  })

  it("derives rpId/origin from the hub's Network address when unconfigured — never the env", async () => {
    const prior = process.env['CAMSTACK_HUB_PUBLIC_URL']
    process.env['CAMSTACK_HUB_PUBLIC_URL'] = 'https://env.example.com'
    try {
      const { result } = await initializeAuthAddon({
        endpoints: [
          {
            label: 'Public tunnel',
            baseUrl: 'https://cams.example.com',
            kind: 'public',
            interfaceKind: 'public',
            plausible: true,
            plausibleReason: '',
            priority: 100,
          },
        ],
      })
      const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> =
        Array.isArray(result) ? result : ((result as any)?.providers ?? [])
      const loginMethodReg = list.find((r) => r.capability.name === 'login-method')
      const methods = await (
        loginMethodReg!.provider as { getLoginMethods: () => Promise<ReadonlyArray<any>> }
      ).getLoginMethods()

      expect(methods.length).toBeGreaterThan(0)
      for (const m of methods) {
        expect(m.rpId).toBe('cams.example.com')
        expect(m.origin).toBe('https://cams.example.com')
      }
    } finally {
      if (prior === undefined) delete process.env['CAMSTACK_HUB_PUBLIC_URL']
      else process.env['CAMSTACK_HUB_PUBLIC_URL'] = prior
    }
  })

  it('falls back to the localhost development default when Network is unreachable', async () => {
    const { result } = await initializeAuthAddon()
    const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = Array.isArray(
      result,
    )
      ? result
      : ((result as any)?.providers ?? [])
    const loginMethodReg = list.find((r) => r.capability.name === 'login-method')
    const methods = await (
      loginMethodReg!.provider as { getLoginMethods: () => Promise<ReadonlyArray<any>> }
    ).getLoginMethods()

    for (const m of methods) {
      expect(m.rpId).toBe('localhost')
      expect(m.origin).toBe('http://localhost:4443')
    }
  })
})

// ---------------------------------------------------------------------------
// success-path audit — `finishAuthentication` (2FA) and
// `finishDiscoverableAuthentication` (usernameless) both log a
// `'passkey login verified'` info entry naming WHICH credential logged
// in — makes the iCloud-Keychain-synced-credential case visible in logs.
// ---------------------------------------------------------------------------

describe('success-path audit log', () => {
  it('logs credentialId + userId + transports on finishAuthentication (2FA) success', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records, { userId: 'u-7', transports: ['internal', 'hybrid'] })
    const { ctx, result } = await initializeAuthAddon({ records })
    const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = Array.isArray(
      result,
    )
      ? result
      : ((result as any)?.providers ?? [])
    const registration = list.find((r) => r.capability.name === 'user-passkeys')
    const provider = registration!.provider as IUserPasskeysProvider

    swanMock.generateAuthenticationOptions.mockResolvedValueOnce({ challenge: 'auth-chal-1' })
    await provider.beginAuthentication({ userId: 'u-7' })
    const finished = await provider.finishAuthentication({
      userId: 'u-7',
      response: makeAssertion('auth-chal-1'),
    })

    expect(finished.verified).toBe(true)
    expect(ctx.logger.info).toHaveBeenCalledWith('passkey login verified', {
      meta: { userId: 'u-7', credentialId: 'cred-1', transports: ['internal', 'hybrid'] },
    })
  })

  it('does NOT log on a failed finishAuthentication', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records, { userId: 'u-7' })
    const { ctx, result } = await initializeAuthAddon({ records })
    const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = Array.isArray(
      result,
    )
      ? result
      : ((result as any)?.providers ?? [])
    const registration = list.find((r) => r.capability.name === 'user-passkeys')
    const provider = registration!.provider as IUserPasskeysProvider

    swanMock.generateAuthenticationOptions.mockResolvedValueOnce({ challenge: 'auth-chal-2' })
    await provider.beginAuthentication({ userId: 'u-7' })
    swanMock.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false })
    const finished = await provider.finishAuthentication({
      userId: 'u-7',
      response: makeAssertion('auth-chal-2'),
    })

    expect(finished.verified).toBe(false)
    expect(ctx.logger.info).not.toHaveBeenCalledWith('passkey login verified', expect.anything())
  })

  it('logs credentialId + userId + transports on finishDiscoverableAuthentication success', async () => {
    const records = await makeWebauthnTestRecords()
    await seedTestPasskey(records, { userId: 'u-8', transports: ['usb'] })
    const { ctx, result } = await initializeAuthAddon({ records })
    const list: ReadonlyArray<{ capability: { name: string }; provider: unknown }> = Array.isArray(
      result,
    )
      ? result
      : ((result as any)?.providers ?? [])
    const registration = list.find((r) => r.capability.name === 'user-passkeys')
    const provider = registration!.provider as IUserPasskeysProvider

    await provider.beginDiscoverableAuthentication({})
    const finished = await provider.finishDiscoverableAuthentication({
      response: makeAssertion('disc-chal-1'),
    })

    expect(finished).toEqual({ verified: true, userId: 'u-8' })
    expect(ctx.logger.info).toHaveBeenCalledWith('passkey login verified', {
      meta: { userId: 'u-8', credentialId: 'cred-1', transports: ['usb'] },
    })
  })
})
