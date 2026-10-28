/** Agent mDNS browse parsing (D857): which agents the hub lists, and how it reads their TXT. */
import { describe, expect, it } from 'vitest'
import { agentsFromResponses } from '../agent-browse.js'
import type { MdnsResponse } from '../mdns-browse.js'

const service = '_camstack-agent._tcp.local'

function response(
  instance: string,
  txt: string[],
  options: { from?: string; port?: number } = {},
): MdnsResponse {
  const name = `${instance}.${service}`
  return {
    from: options.from ?? '192.168.1.20',
    records: [
      { kind: 'ptr', name: service, target: name },
      { kind: 'srv', name, port: options.port ?? 4444, target: `${instance}.local` },
      { kind: 'txt', name, entries: txt },
      { kind: 'a', name: `${instance}.local`, address: options.from ?? '192.168.1.20' },
    ],
  }
}

describe('agentsFromResponses', () => {
  it('lists an unpaired and a paired agent with their state, version and fingerprint', () => {
    const agents = agentsFromResponses([
      response('camstack-agent-agent-a', [
        'nodeId=agent-a',
        'state=unpaired',
        'version=1.2.3',
        'name=garage-arm64',
      ]),
      response('camstack-agent-mac', ['nodeId=mac', 'state=paired', 'fp=0123456789abcdef'], {
        from: '192.168.1.31',
        port: 4445,
      }),
    ])
    expect(agents).toEqual([
      {
        nodeId: 'agent-a',
        host: '192.168.1.20',
        port: 4444,
        version: '1.2.3',
        name: 'garage-arm64',
        state: 'unpaired',
        fingerprint: null,
      },
      {
        nodeId: 'mac',
        host: '192.168.1.31',
        port: 4445,
        version: null,
        name: null,
        state: 'paired',
        fingerprint: '0123456789abcdef',
      },
    ])
  })

  it('reads an unknown state as unpaired, keeps one row per node id, and skips a service with no node id', () => {
    const agents = agentsFromResponses([
      response('a', ['nodeId=agent-a', 'state=weird']),
      response('a-again', ['nodeId=agent-a', 'state=pending']),
      response('nameless', ['state=unpaired']),
    ])
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ nodeId: 'agent-a', state: 'pending' })
  })
})
