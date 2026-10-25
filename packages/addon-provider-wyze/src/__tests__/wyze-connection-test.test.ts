import { describe, expect, it, vi } from 'vitest'
import type { WyzeCamera } from '@apocaliss92/wyze-bridge-js'
import type { WyzeCredentials } from '../cloud-client.js'
import type { WyzeCloudFacade } from '../wyze-connection-test.js'
import { buildWyzeConnectionTestProvider } from '../wyze-connection-test.js'

/**
 * The fake cloud accepts only ONE correct credential set and throws typed
 * errors for every rejection path the real Wyze cloud can produce — MFA,
 * credential failures, rate-limits, and network outages. A fake that always
 * resolved would make the classifier look correct while checking nothing.
 */

const GOOD_PASSWORD = 'correct-horse-battery-staple'
const GOOD_CREDENTIALS: WyzeCredentials = {
  email: 'cam@wyze.example',
  password: GOOD_PASSWORD,
  apiKey: 'apikey-abc',
  apiId: 'id-123',
}

type CloudMode = 'cloud' | 'mfa' | 'rate-limited' | 'credentials-error' | 'network-down'

const FAKE_CAMERAS: WyzeCamera[] = [
  {
    mac: '00:AA:BB:CC:DD:01',
    p2pId: 'UID-01',
    enr: 'ENR',
    ip: '192.168.10.10',
    nickname: 'Front Yard',
    productModel: 'WYZECP',
    productType: 'Camera',
    dtls: 1,
    firmwareVer: '1.0',
    isOnline: true,
  },
  {
    mac: '00:AA:BB:CC:DD:02',
    p2pId: 'UID-02',
    enr: 'ENR',
    ip: '192.168.10.11',
    nickname: 'Back Door',
    productModel: 'WYZECP',
    productType: 'Camera',
    dtls: 1,
    firmwareVer: '1.0',
    isOnline: true,
  },
]

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }
}

function makeFakeFactory(mode: CloudMode): (creds: WyzeCredentials) => WyzeCloudFacade {
  return (creds) => ({
    ensureSession: async (email: string, password: string) => {
      if (mode === 'mfa')
        throw Object.assign(new Error('MFA required'), {
          needsMfa: true,
          mfaType: 'TotpVerificationCode',
        })
      if (mode === 'rate-limited') throw new Error('HTTP 429 too many requests')
      if (mode === 'credentials-error') throw new Error('Wyze login failed (code 1000)')
      if (mode === 'network-down') throw new Error('getaddrinfo ENOTFOUND api.wyzecam.com')
      if (password !== GOOD_PASSWORD || email !== creds.email)
        throw new Error('Wyze login failed (invalid credentials)')
    },
    getCameraList: async () => (mode === 'cloud' ? FAKE_CAMERAS : []),
  })
}

function build(mode: CloudMode = 'cloud') {
  const logger = makeLogger()
  const factory = makeFakeFactory(mode)
  const provider = buildWyzeConnectionTestProvider({ makeCloud: factory, logger: logger as never })
  return { provider, logger }
}

// ---------------------------------------------------------------------------

describe('Wyze connection-test — pre-creation credential validation', () => {
  it('VALIDATES correct credentials and reports the camera count', async () => {
    const { provider } = build()
    const outcome = await provider.testSettings({ settings: { ...GOOD_CREDENTIALS } })
    expect(outcome.outcome).toBe('validated')
    if (outcome.outcome !== 'validated') throw new Error('unreachable')
    // camera count from getCameraList should appear in detail
    expect(outcome.detail).toMatch(/2/)
  })

  it('REJECTS an incomplete form without a round trip', async () => {
    const { provider, logger } = build()
    const outcome = await provider.testSettings({
      settings: { email: 'partial@wyze.example', password: GOOD_PASSWORD },
    })
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome !== 'rejected') throw new Error('unreachable')
    expect(outcome.error).toMatch(/incomplete|invalid/i)
    // No cloud call made — logger.warn for local rejection
    expect(logger.warn).toHaveBeenCalled()
  })

  it('REJECTS an MFA-required account', async () => {
    const { provider } = build('mfa')
    const outcome = await provider.testSettings({ settings: { ...GOOD_CREDENTIALS } })
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome !== 'rejected') throw new Error('unreachable')
    expect(outcome.error).toMatch(/MFA/i)
    // Never echo password back in the error message
    expect(outcome.error).not.toContain(GOOD_PASSWORD)
  })

  it('REJECTS wrong credentials (login-failed error)', async () => {
    const { provider } = build('credentials-error')
    const outcome = await provider.testSettings({ settings: { ...GOOD_CREDENTIALS } })
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome !== 'rejected') throw new Error('unreachable')
    expect(outcome.error).toMatch(/email|password|API/i)
    expect(outcome.error).not.toContain(GOOD_PASSWORD)
  })

  it('is INCONCLUSIVE — never rejected — when rate-limited', async () => {
    const { provider } = build('rate-limited')
    const outcome = await provider.testSettings({ settings: { ...GOOD_CREDENTIALS } })
    // A rate-limit says nothing about credential correctness
    expect(outcome.outcome).toBe('inconclusive')
    if (outcome.outcome !== 'inconclusive') throw new Error('unreachable')
    expect(outcome.error).toMatch(/rate.limit|retry/i)
  })

  it('is INCONCLUSIVE — never rejected — when the cloud is unreachable', async () => {
    const { provider } = build('network-down')
    const outcome = await provider.testSettings({ settings: { ...GOOD_CREDENTIALS } })
    // A DNS / network failure says nothing about the credentials
    expect(outcome.outcome).toBe('inconclusive')
    if (outcome.outcome !== 'inconclusive') throw new Error('unreachable')
    expect(outcome.error).toMatch(/reach|connect/i)
  })

  it('describes what the test does so the UI need not guess', async () => {
    const { provider } = build()
    const desc = await provider.describeTest()
    expect(desc.label).toMatch(/Wyze/i)
    expect(desc.label.length).toBeGreaterThan(20)
  })
})
