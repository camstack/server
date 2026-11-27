import { describe, expect, it } from 'vitest'
import { dialPeer } from '../matter-peer-subscribe.js'

function nodeWith(peerSet: Record<string, unknown>): Record<string, unknown> {
  return {
    env: { get: () => peerSet },
    state: { commissioning: { peerAddress: { fabricIndex: 1, nodeId: 7n } } },
  }
}

describe('dialPeer', () => {
  it('kicks the stalled handshake, then connects, and reports it ran', async () => {
    const calls: string[] = []
    const protocolPeer = {
      kick: () => calls.push('kick'),
      connect: async () => {
        calls.push('connect')
      },
    }
    const dialed = await dialPeer(
      nodeWith({ get: () => protocolPeer }),
      new AbortController().signal,
      () => undefined,
    )
    expect(dialed).toBe(true)
    expect(calls).toEqual(['kick', 'connect'])
  })

  it('returns false and names the lookup when PeerSet has no peer', async () => {
    const reasons: string[] = []
    const dialed = await dialPeer(
      nodeWith({ get: () => undefined }),
      new AbortController().signal,
      (reason) => reasons.push(reason),
    )
    expect(dialed).toBe(false)
    expect(reasons).toEqual(['PeerSet has no such peer'])
  })
})
