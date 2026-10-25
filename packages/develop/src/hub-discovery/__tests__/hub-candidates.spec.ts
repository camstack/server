/** Candidate merging and the probe-filtered union, shared by the CLI and the agent backend. */
import { describe, expect, it } from 'vitest'
import { discoverHubs, mergeCandidates, normalizeHubUrl } from '../hub-candidates.js'
import type { MdnsHub } from '../mdns-browse.js'

const mdnsHub = (url: string): MdnsHub => ({ url, nodeId: 'hub', version: '1.2.3' })
const reachable =
  (...ok: string[]) =>
  async (host: string, port: number) =>
    ok.includes(`${host}:${port}`)

describe('normalizeHubUrl', () => {
  it('keeps host:port, defaults to 443, brackets IPv6, refuses non-http', () => {
    expect(normalizeHubUrl('http://192.0.2.10:4443/x')?.url).toBe('https://192.0.2.10:4443')
    expect(normalizeHubUrl('https://hub.lan')?.port).toBe(443)
    expect(normalizeHubUrl('https://[fd00::1]:4443')?.url).toBe('https://[fd00::1]:4443')
    expect(normalizeHubUrl('ftp://hub')).toBeNull()
    expect(normalizeHubUrl('not a url')).toBeNull()
  })
})

describe('mergeCandidates', () => {
  it('dedupes by host:port, keeps every source once and the first identity', () => {
    const merged = mergeCandidates([
      { url: 'https://192.0.2.10:4443', source: 'LAN (mDNS)', nodeId: 'hub', version: '1' },
      { url: 'http://192.0.2.10:4443', source: 'configured' },
      { url: 'https://192.0.2.10:4443', source: 'configured' },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.sources).toEqual(['LAN (mDNS)', 'configured'])
    expect(merged[0]?.nodeId).toBe('hub')
  })
})

describe('discoverHubs', () => {
  it('unions mDNS with the caller-known hubs and drops the unreachable', async () => {
    const hubs = await discoverHubs({
      known: [
        { url: 'https://192.0.2.10:4443', source: 'configured hub' },
        { url: 'https://192.168.1.77:4443', source: 'configured hub' },
      ],
      browse: async () => [mdnsHub('https://192.0.2.10:4443'), mdnsHub('https://192.168.1.5:4443')],
      probe: reachable('192.0.2.10:4443', '192.168.1.5:4443'),
    })
    const byUrl = new Map(hubs.map((h) => [h.url, h]))
    expect(hubs).toHaveLength(2)
    expect(byUrl.get('https://192.0.2.10:4443')?.sources).toEqual(['LAN (mDNS)', 'configured hub'])
    expect(byUrl.get('https://192.168.1.5:4443')?.sources).toEqual(['LAN (mDNS)'])
  })

  it('finds nothing without throwing when nothing is announced or known', async () => {
    expect(await discoverHubs({ browse: async () => [], probe: reachable() })).toEqual([])
  })
})
