import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  withTags: () => noopLogger,
} as unknown as LwaEventGatewayDeps['logger']

function makeDeps(opts: {
  removeLinkedAccount: (userId: string) => Promise<void>
}): LwaEventGatewayDeps {
  return {
    ctx: {
      eventBus: { subscribe: () => () => {} },
      api: {},
    } as unknown as LwaEventGatewayDeps['ctx'],
    logger: noopLogger,
    listExposed: () => [],
    listLinkedAccounts: () => [{ userId: 'userA', username: 'userA', linkedAt: 0 }],
    listTokens: () => [
      {
        userId: 'userA',
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: Date.now() + 1e9,
        receivedAt: 0,
      },
    ],
    upsertToken: async () => {},
    removeLinkedAccount: opts.removeLinkedAccount,
    getAdvertisedBrokerUrl: () => null,
    getRegion: () => 'NA',
    getExportedSignature: () => null,
    accountMaySee: () => true,
  }
}

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(0)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('postReport — unlink on gateway 403', () => {
  it('403 response → returns false and unlinks the revoked account once', async () => {
    const removeLinkedAccount = vi.fn(async () => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, text: async () => '' }) as unknown as Response),
    )

    const gw = new LwaEventGateway(makeDeps({ removeLinkedAccount }))
    const result = await gw.postReport('userA', () => ({}), 'x')

    expect(result).toBe(false)
    expect(removeLinkedAccount).toHaveBeenCalledTimes(1)
    expect(removeLinkedAccount).toHaveBeenCalledWith('userA')
  })

  it('200 response → returns true and does NOT unlink', async () => {
    const removeLinkedAccount = vi.fn(async () => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response),
    )

    const gw = new LwaEventGateway(makeDeps({ removeLinkedAccount }))
    const result = await gw.postReport('userA', () => ({}), 'x')

    expect(result).toBe(true)
    expect(removeLinkedAccount).not.toHaveBeenCalled()
  })
})
