/** mDNS browse parsing and socket handling (D838), shared by the CLI and the agent backend. */
import { describe, expect, it } from 'vitest'
import {
  browseHubsMdns,
  hubsFromResponses,
  type MdnsResponse,
  type MdnsSocket,
} from '../mdns-browse.js'

describe('mDNS browse', () => {
  const instance = 'camstack-hub._camstack._tcp.local'
  const response = (txt: string[], from = '192.0.2.10'): MdnsResponse => ({
    from,
    records: [
      { kind: 'ptr', name: '_camstack._tcp.local', target: instance },
      { kind: 'srv', name: instance, port: 4443, target: 'camstack-hub.local' },
      { kind: 'txt', name: instance, entries: txt },
      { kind: 'a', name: 'camstack-hub.local', address: '192.0.2.10' },
    ],
  })

  it('prefers the advertised url, and falls back to the A record and port', () => {
    const withUrl = hubsFromResponses([
      response(['nodeId=hub', 'role=hub', 'url=https://camstack.lan:4443', 'version=1.2.3']),
    ])
    expect(withUrl).toEqual([{ url: 'https://camstack.lan:4443', nodeId: 'hub', version: '1.2.3' }])
    const without = hubsFromResponses([response(['role=hub'])])
    expect(without[0]?.url).toBe('https://192.0.2.10:4443')
  })

  it('lists only hubs: a service whose role is not hub is skipped', () => {
    expect(hubsFromResponses([response(['role=agent'])])).toEqual([])
  })

  it('collects responses from a socket, re-asks, destroys it, and survives a socket error', async () => {
    const asked: string[] = []
    let destroyed = false
    const problems: string[] = []
    const socket: MdnsSocket = {
      onResponse: (listener) => {
        setTimeout(() => listener(response(['role=hub', 'nodeId=hub'])), 5)
      },
      onError: (listener) => {
        setTimeout(() => listener(new Error('addMembership failed')), 1)
      },
      query: (name) => void asked.push(name),
      destroy: () => {
        destroyed = true
      },
    }
    const hubs = await browseHubsMdns({
      timeoutMs: 40,
      requeryMs: 10,
      createSocket: () => socket,
      onProblem: (m) => void problems.push(m),
    })
    expect(hubs).toHaveLength(1)
    expect(asked[0]).toBe('_camstack._tcp.local')
    expect(asked.length).toBeGreaterThan(1)
    expect(destroyed).toBe(true)
    expect(problems).toEqual(['addMembership failed'])
  })

  it('reports a socket that cannot be created and returns no hubs', async () => {
    const problems: string[] = []
    const hubs = await browseHubsMdns({
      timeoutMs: 5,
      createSocket: () => {
        throw new Error('EPERM')
      },
      onProblem: (m) => void problems.push(m),
    })
    expect(hubs).toEqual([])
    expect(problems).toEqual(['EPERM'])
  })
})
