/**
 * The hubs the agent UI offers (D839): mDNS plus the configured hub address,
 * unreachable ones dropped, a scan only on request. Fakes stand in for the
 * multicast socket and the https probe; the discovery module itself is the
 * real one, so the dedupe and the probe filter are exercised for real.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MdnsHub } from '@camstack/develop/hub-discovery'
import { discoverHubs } from '@camstack/develop/hub-discovery'
import type { ServiceBroker } from 'moleculer'
import { afterAll, describe, expect, it } from 'vitest'
import { createAgentHttpServer } from '../agent-http.js'
import {
  CONFIGURED_HUB_SOURCE,
  type DiscoverHubsFn,
  type HubsFoundSnapshot,
  createHubsFinder,
} from '../hubs-found.js'

const announced = (url: string, nodeId = 'hub'): MdnsHub => ({ url, nodeId, version: '1.2.3' })

/** The real discovery with the network replaced: what mDNS says, who answers. */
function fakeNetwork(mdns: readonly MdnsHub[], reachable: readonly string[]): DiscoverHubsFn {
  return (deps) =>
    discoverHubs({
      ...deps,
      browse: async () => mdns,
      probe: async (host, port) => reachable.includes(`${host}:${port}`),
    })
}

describe('createHubsFinder', () => {
  it('lists mDNS hubs and the configured hub, deduped, with every source', async () => {
    const finder = createHubsFinder({
      getConfiguredHubAddress: () => '192.0.2.10',
      discover: fakeNetwork(
        [announced('https://192.0.2.10:4443'), announced('https://192.168.1.5:4443', 'hub-b')],
        ['192.0.2.10:4443', '192.168.1.5:4443'],
      ),
    })
    const snap = await finder.refresh()
    const byUrl = new Map(snap.hubs.map((h) => [h.url, h]))
    expect(snap.hubs).toHaveLength(2)
    expect(byUrl.get('https://192.0.2.10:4443')?.sources).toEqual([
      'LAN (mDNS)',
      CONFIGURED_HUB_SOURCE,
    ])
    expect(byUrl.get('https://192.168.1.5:4443')?.nodeId).toBe('hub-b')
    expect(byUrl.get('https://192.168.1.5:4443')?.host).toBe('192.168.1.5')
  })

  it('drops a hub that does not answer on https, announced or configured', async () => {
    const finder = createHubsFinder({
      getConfiguredHubAddress: () => '192.168.1.77',
      discover: fakeNetwork(
        [announced('https://192.0.2.10:4443'), announced('https://192.168.1.5:4443')],
        ['192.0.2.10:4443'],
      ),
    })
    const snap = await finder.refresh()
    expect(snap.hubs.map((h) => h.url)).toEqual(['https://192.0.2.10:4443'])
  })

  it('offers the configured hub alone when nothing is announced', async () => {
    const finder = createHubsFinder({
      getConfiguredHubAddress: () => '192.0.2.10:6000',
      discover: fakeNetwork([], ['192.0.2.10:4443']),
    })
    expect((await finder.refresh()).hubs.map((h) => h.sources)).toEqual([[CONFIGURED_HUB_SOURCE]])
  })

  it('answers an empty list, not an error, when nothing is found', async () => {
    const finder = createHubsFinder({
      getConfiguredHubAddress: () => null,
      discover: fakeNetwork([], []),
    })
    expect(finder.snapshot().scannedAt).toBeNull()
    const snap = await finder.refresh()
    expect(snap.hubs).toEqual([])
    expect(snap.scannedAt).not.toBeNull()
  })

  it('shares one scan between concurrent refreshes and rescans only after the interval', async () => {
    let scans = 0
    let clock = 1_000
    const finder = createHubsFinder({
      getConfiguredHubAddress: () => null,
      now: () => clock,
      discover: async () => {
        scans += 1
        return []
      },
    })
    await Promise.all([finder.refresh(), finder.refresh(), finder.refresh()])
    expect(scans).toBe(1)
    await finder.refresh()
    expect(scans).toBe(1)
    clock += 10_000
    await finder.refresh()
    expect(scans).toBe(2)
  })

  it('keeps the previous list when a scan throws', async () => {
    let fail = false
    let clock = 0
    const logs: string[] = []
    const finder = createHubsFinder({
      getConfiguredHubAddress: () => null,
      now: () => clock,
      log: (m) => logs.push(m),
      discover: async (deps) => {
        if (fail) throw new Error('multicast down')
        return fakeNetwork([announced('https://192.0.2.10:4443')], ['192.0.2.10:4443'])(deps)
      },
    })
    expect((await finder.refresh()).hubs).toHaveLength(1)
    fail = true
    clock += 10_000
    expect((await finder.refresh()).hubs).toHaveLength(1)
    expect(logs.join()).toContain('multicast down')
  })
})

describe('agent HTTP hubs-found routes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hubs-found-'))
  const closers: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const close of closers) await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const stubBroker = {
    nodeID: 'agent',
    call: async () => ({}),
    registry: { getNodeList: () => [] },
  }

  async function serve(finderDiscover: DiscoverHubsFn, hubAddress?: string) {
    const configPath = path.join(tmpDir, `agent-${closers.length}.json`)
    fs.writeFileSync(configPath, JSON.stringify(hubAddress ? { hubAddress } : {}))
    const finder = createHubsFinder({
      getConfiguredHubAddress: () => hubAddress ?? null,
      discover: finderDiscover,
    })
    const app = await createAgentHttpServer(() => stubBroker as unknown as ServiceBroker, {
      port: 0,
      nodeId: 'agent',
      dataDir: tmpDir,
      configPath,
      hubsFinder: finder,
    })
    closers.push(() => app.close())
    return app
  }

  it('GET is the cached snapshot (no scan), POST refresh scans and returns the hubs', async () => {
    let scans = 0
    const app = await serve(async (deps) => {
      scans += 1
      return fakeNetwork([announced('https://192.0.2.10:4443')], ['192.0.2.10:4443'])(deps)
    })
    const before = (
      await app.inject({ method: 'GET', url: '/api/agent/hubs-found' })
    ).json<HubsFoundSnapshot>()
    expect(before.hubs).toEqual([])
    expect(scans).toBe(0)
    const after = (
      await app.inject({
        method: 'POST',
        url: '/api/agent/hubs-found/refresh',
        headers: { 'content-type': 'application/json' },
        payload: {},
      })
    ).json<HubsFoundSnapshot>()
    expect(after.hubs.map((h) => h.host)).toEqual(['192.0.2.10'])
    expect(scans).toBe(1)
    const cached = (
      await app.inject({ method: 'GET', url: '/api/agent/hubs-found' })
    ).json<HubsFoundSnapshot>()
    expect(cached.hubs).toHaveLength(1)
  })

  it('the status poll never scans and carries no discovery-mode fields', async () => {
    let scans = 0
    const app = await serve(async () => {
      scans += 1
      return []
    })
    const status = (await app.inject({ method: 'GET', url: '/api/agent/status' })).json<
      Record<string, unknown>
    >()
    expect(scans).toBe(0)
    expect(status).not.toHaveProperty('discoveryMode')
    expect(status).not.toHaveProperty('hubsFound')
  })
})
