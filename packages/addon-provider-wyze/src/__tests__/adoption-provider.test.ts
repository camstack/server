import { describe, expect, it, vi } from 'vitest'
import type { WyzeCamera } from '@apocaliss92/wyze-bridge-js'
import type { IScopedLogger } from '@camstack/types'
import { buildWyzeAdoptionProvider } from '../wyze-adoption-provider.js'
import type { AdoptedWyzeCamera, WyzeAdoptionProviderDeps } from '../wyze-adoption-provider.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as IScopedLogger

function cam(mac: string, nickname: string): WyzeCamera {
  return {
    mac,
    p2pId: `UID-${mac}`,
    enr: 'ENR',
    ip: '192.168.10.9',
    nickname,
    productModel: 'WYZE_CAKP2JFUS',
    productType: 'Camera',
    dtls: 1,
    firmwareVer: '1.0',
    isOnline: true,
  }
}

function makeDeps(
  overrides: Partial<WyzeAdoptionProviderDeps> & {
    cameras?: Record<string, readonly WyzeCamera[]>
    adopted?: readonly AdoptedWyzeCamera[]
  } = {},
): WyzeAdoptionProviderDeps {
  const cameras = overrides.cameras ?? {}
  const adopted = overrides.adopted ?? []
  return {
    getCameraList: async (integrationId) => cameras[integrationId] ?? [],
    hasIntegration: (integrationId) => integrationId in cameras,
    listIntegrations: () => Object.keys(cameras),
    listAdopted: async () => adopted,
    adoptCamera: vi.fn(async ({ mac }) => ({ deviceId: mac === 'AA' ? 1 : 2 })),
    removeDevice: vi.fn(async () => {}),
    findDeviceConfig: async () => null,
    logger,
    ...overrides,
  }
}

describe('buildWyzeAdoptionProvider', () => {
  it('lists candidates scoped to the integration and dedupes already-adopted', async () => {
    const p = buildWyzeAdoptionProvider(
      makeDeps({
        cameras: { 'int-1': [cam('AA', 'Front'), cam('BB', 'Back')] },
        adopted: [{ id: 7, config: { integrationId: 'int-1', mac: 'AA' } }],
      }),
    )
    const res = await p.listCandidates({ integrationId: 'int-1', page: 1, pageSize: 50 })
    expect(res.totalCount).toBe(2)
    const front = res.candidates.find((c) => c.childNativeId === 'AA')
    expect(front?.alreadyAdopted).toBe(true)
    expect(front?.adoptedDeviceId).toBe(7)
    const back = res.candidates.find((c) => c.childNativeId === 'BB')
    expect(back?.alreadyAdopted).toBe(false)
  })

  it('adopts by MAC, routing through the integration client', async () => {
    const adoptCamera = vi.fn(async () => ({ deviceId: 99 }))
    const p = buildWyzeAdoptionProvider(
      makeDeps({ cameras: { 'int-1': [cam('AA', 'Front')] }, adoptCamera }),
    )
    const res = await p.adopt({ integrationId: 'int-1', childNativeIds: ['AA'] })
    expect(res.adopted).toEqual([
      { childNativeId: 'AA', parentDeviceId: 99, accessoryDeviceIds: [] },
    ])
    expect(adoptCamera).toHaveBeenCalledWith({ integrationId: 'int-1', mac: 'AA', name: 'Front' })
  })

  it('throws when adopting against an unknown integration', async () => {
    const p = buildWyzeAdoptionProvider(makeDeps({ cameras: {} }))
    await expect(p.adopt({ integrationId: 'nope', childNativeIds: ['AA'] })).rejects.toThrow(
      /not connected/,
    )
  })

  it('getStatus surfaces a lastError when getCameraList silently failed', async () => {
    // The registry catches getCameraList errors and returns the empty cache so
    // individual callers (live cameras) are not disrupted. But getStatus MUST
    // surface the error so the operator knows why the adoption panel is empty.
    const p = buildWyzeAdoptionProvider(
      makeDeps({
        cameras: { 'int-1': [] }, // empty cache (simulate post-failure state)
        getLastFetchError: () => ({ kind: 'unknown', message: 'fetch failed' }),
      }),
    )
    const status = await p.getStatus({ deviceId: 0 })
    if (status === null) throw new Error('unreachable')
    expect(status.candidateCount).toBe(0)
    // Without the fix this would be null — the operator sees nothing
    expect(status.lastError).not.toBeNull()
    expect(status.lastError).toMatch(/fetch failed/)
  })

  it('refresh totals candidates for the integration', async () => {
    const p = buildWyzeAdoptionProvider(
      makeDeps({
        cameras: { 'int-1': [cam('AA', 'A'), cam('BB', 'B')] },
        adopted: [{ id: 1, config: { integrationId: 'int-1', mac: 'AA' } }],
      }),
    )
    const status = await p.refresh({ integrationId: 'int-1' })
    expect(status.candidateCount).toBe(2)
    expect(status.adoptedCount).toBe(1)
    expect(status.lastError).toBeNull()
  })

  it('refresh surfaces lastError after a silent getCameraList failure', async () => {
    const p = buildWyzeAdoptionProvider(
      makeDeps({
        cameras: { 'int-1': [] },
        getLastFetchError: () => ({
          kind: 'unknown',
          message: 'unable to get local issuer certificate',
        }),
      }),
    )
    const status = await p.refresh({ integrationId: 'int-1' })
    expect(status.candidateCount).toBe(0)
    expect(status.lastError).toMatch(/issuer certificate/)
  })
})
