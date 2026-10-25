import { describe, expect, it, vi } from 'vitest'
import type { AddonApi } from '../../generated/addon-api.js'
import { invokeTrpcLeaf, readTrpcLeaf } from '../trpc-leaf.js'

/**
 * tRPC v11 client routers are Proxy objects: `typeof api.deviceState === 'function'`
 * while method leaves are function-objects carrying `.query` / `.mutate`.
 */
function fakeTrpcV11AddonApi(): AddonApi {
  const setRuntimeState = Object.assign(
    vi.fn((input: unknown) => ({ ok: true, input })),
    { mutate: vi.fn((input: unknown) => ({ ok: true, input })) },
  )
  const deviceState = Object.assign(() => undefined, { setRuntimeState })
  return { deviceState } as unknown as AddonApi
}

describe('readTrpcLeaf / invokeTrpcLeaf', () => {
  it('reads a cap router that is a function-proxy and invokes mutate on a method leaf', () => {
    const api = fakeTrpcV11AddonApi()
    const leaf = readTrpcLeaf(api, 'deviceState', 'setRuntimeState')
    expect(typeof leaf.mutate).toBe('function')

    const result = invokeTrpcLeaf<{ ok: boolean; input: unknown }>(
      api,
      'deviceState',
      'setRuntimeState',
      'mutation',
      { deviceId: 29, patch: { state: 'running' } },
    )
    expect(result.ok).toBe(true)
    expect(result.input).toEqual({ deviceId: 29, patch: { state: 'running' } })
  })

  it('rejects null, arrays and missing routers', () => {
    expect(() =>
      readTrpcLeaf({ deviceState: null } as unknown as AddonApi, 'deviceState', 'x'),
    ).toThrow(/no router 'deviceState'/)
    expect(() =>
      readTrpcLeaf({ deviceState: ['not-a-router'] } as unknown as AddonApi, 'deviceState', 'x'),
    ).toThrow(/no router 'deviceState'/)
    expect(() => readTrpcLeaf({} as AddonApi, 'deviceState', 'setRuntimeState')).toThrow(
      /no router 'deviceState'/,
    )
  })

  it('rejects method leaves without query/mutate/subscribe', () => {
    const deviceState = Object.assign(() => undefined, {
      setRuntimeState: Object.assign(() => undefined, {}),
    })
    expect(() =>
      readTrpcLeaf({ deviceState } as unknown as AddonApi, 'deviceState', 'setRuntimeState'),
    ).toThrow(/no 'deviceState.setRuntimeState'/)
  })
})
