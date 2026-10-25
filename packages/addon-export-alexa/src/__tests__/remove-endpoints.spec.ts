/**
 * "Remove ids from Alexa" — the Troubleshooting action that sends a
 * DeleteReport for ids the operator types. Its result must say what was
 * DELIVERED, and the local tracking may forget an id only once every linked
 * account accepted the delete.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'
import {
  forgetDeliveredEndpointIds,
  parseEndpointIds,
  removeEndpointsFromAlexa,
} from '../remove-endpoints.js'
import type { PurgeEndpointsResult } from '../lwa-event-gateway.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  withTags: () => noopLogger,
} as unknown as LwaEventGatewayDeps['logger']

function deps(users: readonly string[], tokenless: readonly string[] = []): LwaEventGatewayDeps {
  return {
    ctx: {
      eventBus: { subscribe: () => () => {} },
      api: {},
    } as unknown as LwaEventGatewayDeps['ctx'],
    logger: noopLogger,
    listExposed: () => [],
    listLinkedAccounts: () => users.map((userId) => ({ userId, username: userId, linkedAt: 0 })),
    listTokens: () =>
      users
        .filter((u) => !tokenless.includes(u))
        .map((userId) => ({
          userId,
          accessToken: `tok-${userId}`,
          refreshToken: 'ref',
          expiresAt: Date.now() + 1e9,
          receivedAt: 0,
        })),
    upsertToken: async () => {},
    removeLinkedAccount: async () => {},
    getAdvertisedBrokerUrl: () => null,
    getRegion: () => 'NA',
    getExportedSignature: () => null,
    accountMaySee: () => true,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseEndpointIds', () => {
  it('splits on commas, whitespace and newlines, dropping blanks and duplicates', () => {
    expect(parseEndpointIds(' 54, 54__privacy\n54__98  54 ')).toEqual([
      '54',
      '54__privacy',
      '54__98',
    ])
    expect(parseEndpointIds('  ')).toEqual([])
  })
})

describe('forgetDeliveredEndpointIds', () => {
  it('trims the ids off each tracked device and drops a device left with none', () => {
    expect(
      forgetDeliveredEndpointIds({ 54: ['54', '54__privacy'], 7: ['7'] }, ['54', '7']),
    ).toEqual({ 54: ['54__privacy'] })
  })
})

describe('LwaEventGateway.purgeEndpoints — counts what was delivered', () => {
  it('a gateway refusal is a failed account, not a delivered one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        const ok = init.headers['Authorization'] === 'Bearer tok-a'
        return { ok, status: ok ? 202 : 400, text: async () => '' } as unknown as Response
      }),
    )
    const gw = new LwaEventGateway(deps(['a', 'b']))
    const r = await gw.purgeEndpoints(['54'])
    expect(r).toEqual({ requested: 1, accountCount: 2, deliveredAccounts: 1, failedAccounts: 1 })
  })

  it('an account with no push grant is failed too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 202, text: async () => '' }) as unknown as Response),
    )
    const gw = new LwaEventGateway(deps(['a', 'b'], ['b']))
    const r = await gw.purgeEndpoints(['54'])
    expect(r).toEqual({ requested: 1, accountCount: 2, deliveredAccounts: 1, failedAccounts: 1 })
  })
})

describe('removeEndpointsFromAlexa — the action', () => {
  function run(result: PurgeEndpointsResult | null, raw = '54 54__privacy') {
    const tracked: Record<number, readonly string[]> = { 54: ['54', '54__privacy', '54__98'] }
    const writes: Array<Record<number, readonly string[]>> = []
    const purge = vi.fn(async () => {
      if (result === null) throw new Error('unreachable')
      return result
    })
    const promise = removeEndpointsFromAlexa({
      raw,
      purge,
      getTracked: () => tracked,
      setTracked: async (next) => {
        writes.push(next)
      },
    })
    return { promise, writes, purge }
  }

  it('refuses an empty list without sending anything', async () => {
    const { promise, purge } = run(null, ' , ')
    await expect(promise).rejects.toThrow(/no endpoint id/i)
    expect(purge).not.toHaveBeenCalled()
  })

  it('refuses when there is no linked account', async () => {
    const { promise, writes } = run({
      requested: 2,
      accountCount: 0,
      deliveredAccounts: 0,
      failedAccounts: 0,
    })
    await expect(promise).rejects.toThrow(/no linked/i)
    expect(writes).toEqual([])
  })

  it('a delete that did not reach every account fails, and nothing is forgotten', async () => {
    const { promise, writes } = run({
      requested: 2,
      accountCount: 2,
      deliveredAccounts: 1,
      failedAccounts: 1,
    })
    await expect(promise).rejects.toThrow(/1 of 2/)
    expect(writes).toEqual([])
  })

  it('a delete every account accepted forgets exactly those ids', async () => {
    const { promise, writes } = run({
      requested: 2,
      accountCount: 1,
      deliveredAccounts: 1,
      failedAccounts: 0,
    })
    await expect(promise).resolves.toMatchObject({ deliveredAccounts: 1 })
    expect(writes).toEqual([{ 54: ['54__98'] }])
  })
})
