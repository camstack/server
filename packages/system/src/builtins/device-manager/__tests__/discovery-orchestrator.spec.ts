import type {
  DiscoveryHit,
  DiscoveryMode,
  IScopedLogger,
  LogExtras,
  ScanNetworkResult,
} from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { type DiscoveryOrchestratorDeps, discoverProviders } from '../discovery-orchestrator.js'

class QuietLogger implements IScopedLogger {
  readonly warn = vi.fn<(message: string, extras?: LogExtras) => void>()
  debug(): void {}
  info(): void {}
  error(): void {}
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }
}

function candidate(stableId: string) {
  return { stableId, type: DeviceType.Container, suggestedName: stableId, prefilledConfig: {} }
}

const probe: DiscoveryMode = { kind: 'http-probe', port: 80, path: '/', method: 'GET', tls: false }

function hit(modeIndex: number, host: string): DiscoveryHit {
  return { modeIndex, host, port: 80 }
}

function fakeProvider(modes: readonly DiscoveryMode[] | 'missing') {
  return {
    getDiscoveryModes: vi.fn(async (_input: object): Promise<DiscoveryMode[]> => {
      if (modes === 'missing') throw new Error('No procedure found on path')
      return [...modes]
    }),
    classifyDiscoveryHits: vi.fn(
      async (input: { hits: DiscoveryHit[]; params?: Record<string, unknown> }) =>
        input.hits.map((h) => candidate(`found-${h.host}`)),
    ),
    discoverDevices: vi.fn(async (_input: { params?: Record<string, unknown> }) => [
      candidate('legacy'),
    ]),
  }
}

type FakeProvider = ReturnType<typeof fakeProvider>

function setup(
  providers: Record<string, FakeProvider>,
  scanResult: ScanNetworkResult,
  owned: ReadonlySet<string> = new Set(),
): { deps: DiscoveryOrchestratorDeps; scan: ReturnType<typeof vi.fn> } {
  const scan = vi.fn(async (_input: { requests: readonly unknown[] }) => scanResult)
  const deps: DiscoveryOrchestratorDeps = {
    requireProvider: async (id) => {
      const p = providers[id]
      if (p === undefined) throw new Error(`no ${id}`)
      return p
    },
    scanNetwork: scan,
    originStableIds: async () => owned,
    logger: new QuietLogger(),
  }
  return { deps, scan }
}

const emptyStats = { hostsProbed: 0, hits: 0, timeouts: 0, byMode: {} }

describe('discoverProviders', () => {
  it('runs ONE scan and routes each hit only to the provider whose mode produced it', async () => {
    const a = fakeProvider([probe])
    const b = fakeProvider([probe, probe])
    const { deps, scan } = setup(
      { a, b },
      {
        hits: [
          { providerId: 'a', hit: hit(0, '10.0.0.1') },
          { providerId: 'b', hit: hit(1, '10.0.0.2') },
        ],
        subnetsScanned: ['10.0.0.0/24'],
        errors: [],
        stats: emptyStats,
      },
    )
    const out = await discoverProviders(deps, { addonIds: ['a', 'b'] })
    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan.mock.calls[0]?.[0].requests).toHaveLength(2)
    expect(a.classifyDiscoveryHits.mock.calls[0]?.[0].hits).toEqual([hit(0, '10.0.0.1')])
    expect(b.classifyDiscoveryHits.mock.calls[0]?.[0].hits).toEqual([hit(1, '10.0.0.2')])
    expect(a.discoverDevices).not.toHaveBeenCalled()
    expect(b.discoverDevices).not.toHaveBeenCalled()
    expect(out.map((o) => o.candidates.map((c) => c.stableId))).toEqual([
      ['found-10.0.0.1'],
      ['found-10.0.0.2'],
    ])
  })

  it('a legacy provider still uses discoverDevices and does not enter the scan', async () => {
    const legacy = fakeProvider([])
    const old = fakeProvider('missing')
    const { deps, scan } = setup(
      { legacy, old },
      { hits: [], subnetsScanned: [], errors: [], stats: emptyStats },
    )
    const out = await discoverProviders(deps, {
      addonIds: ['legacy', 'old'],
      params: { broadcast: '1.2.3.255' },
    })
    expect(scan).not.toHaveBeenCalled()
    expect(legacy.discoverDevices).toHaveBeenCalledWith({ params: { broadcast: '1.2.3.255' } })
    expect(old.discoverDevices).toHaveBeenCalledTimes(1)
    expect(legacy.classifyDiscoveryHits).not.toHaveBeenCalled()
    expect(out.map((o) => o.candidates[0]?.stableId)).toEqual(['legacy', 'legacy'])
  })

  it('a provider with a custom mode gets the scanned subnets and its candidates are merged', async () => {
    const reolink = fakeProvider([probe, { kind: 'custom', reason: 'vendor udp' }])
    const { deps } = setup(
      { reolink },
      {
        hits: [{ providerId: 'reolink', hit: hit(0, '10.0.0.7') }],
        subnetsScanned: ['10.0.0.0/24', '192.168.20.0/24'],
        errors: [],
        stats: emptyStats,
      },
    )
    const [out] = await discoverProviders(deps, { addonIds: ['reolink'] })
    expect(reolink.discoverDevices).toHaveBeenCalledWith({
      params: { subnets: ['10.0.0.0/24', '192.168.20.0/24'] },
    })
    expect(out?.candidates.map((c) => c.stableId)).toEqual(['found-10.0.0.7', 'legacy'])
  })

  it('a custom-only provider is not sent to the engine as a sweep but still gets subnets', async () => {
    const gree = fakeProvider([{ kind: 'custom', reason: 'vendor udp' }])
    const { deps } = setup(
      { gree },
      { hits: [], subnetsScanned: ['10.0.0.0/24'], errors: [], stats: emptyStats },
    )
    await discoverProviders(deps, { addonIds: ['gree'], params: { x: 1 } })
    expect(gree.classifyDiscoveryHits).not.toHaveBeenCalled()
    expect(gree.discoverDevices).toHaveBeenCalledWith({
      params: { x: 1, subnets: ['10.0.0.0/24'] },
    })
  })

  it('a failed scan fails only the providers that needed it', async () => {
    const a = fakeProvider([probe])
    const legacy = fakeProvider([])
    const scan = vi.fn(async () => {
      throw new Error('bad subnet')
    })
    const out = await discoverProviders(
      {
        requireProvider: async (id) => (id === 'a' ? a : legacy),
        scanNetwork: scan,
        originStableIds: async () => new Set<string>(),
        logger: new QuietLogger(),
      },
      { addonIds: ['a', 'legacy'] },
    )
    expect(out[0]).toMatchObject({ addonId: 'a', error: 'bad subnet', candidates: [] })
    expect(out[1]).toMatchObject({ addonId: 'legacy', error: null })
  })

  it('hides a candidate whose stableId already belongs to an integration, for every provider', async () => {
    const a = fakeProvider([probe])
    const legacy = fakeProvider([])
    const { deps } = setup(
      { a, legacy },
      {
        hits: [
          { providerId: 'a', hit: hit(0, '10.0.0.1') },
          { providerId: 'a', hit: hit(0, '10.0.0.2') },
        ],
        subnetsScanned: ['10.0.0.0/24'],
        errors: [],
        stats: emptyStats,
      },
      new Set(['found-10.0.0.1', 'legacy']),
    )
    const out = await discoverProviders(deps, { addonIds: ['a', 'legacy'] })
    expect(out.find((o) => o.addonId === 'a')?.candidates.map((c) => c.stableId)).toEqual([
      'found-10.0.0.2',
    ])
    expect(out.find((o) => o.addonId === 'legacy')?.candidates).toEqual([])
  })

  it('shows everything when the owned set cannot be read (a failed read hides nothing)', async () => {
    const a = fakeProvider([])
    const { deps } = setup({ a }, { hits: [], subnetsScanned: [], errors: [], stats: emptyStats })
    const failing: DiscoveryOrchestratorDeps = {
      ...deps,
      originStableIds: async () => {
        throw new Error('boom')
      },
    }
    const [out] = await discoverProviders(failing, { addonIds: ['a'] })
    expect(out?.candidates.map((c) => c.stableId)).toEqual(['legacy'])
  })
})
