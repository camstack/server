/**
 * A packet off the wire must name a sender that is neither missing nor this node (D857).
 *
 * The mesh access middleware reads a missing or own sender as an IN-PROCESS call and skips
 * the hub gate, so the transporter is where those two are stopped: one msgpack REQUEST with
 * no sender, or with the receiver's own id, would otherwise reach `$agent.deploy` or
 * `$process.spawnRunner`.
 */
import { describe, expect, it, vi } from 'vitest'
import { TlsTcpTransporter } from '../tls-tcp-transporter.js'

const OWN = 'agent-1'

function rig(opts: { hubOnlyPeers: boolean }) {
  const t = new TlsTcpTransporter({ hubOnlyPeers: opts.hubOnlyPeers })
  const delivered: unknown[] = []
  const warnings: string[] = []
  Object.assign(t, {
    nodeID: OWN,
    logger: { warn: (m: string) => warnings.push(m), info: () => {}, debug: () => {} },
    deserialize: (_type: string, message: Buffer) => JSON.parse(message.toString()),
    receive: vi.fn((_cmd: string, data: Buffer) => delivered.push(JSON.parse(data.toString()))),
  })
  return { t, delivered, warnings }
}

const packet = (payload: Record<string, unknown>): Buffer =>
  Buffer.from(JSON.stringify({ payload }))

/** A socket the transporter takes for an authenticated TLS peer whose certificate CN is `cn`. */
function tlsSocketOf(cn: string) {
  return {
    encrypted: true,
    getPeerCertificate: () => ({}),
    meshPeerCn: cn,
    meshPeerSerial: '',
    destroy: () => undefined,
  } as never
}

describe('the transporter drops a packet with no usable sender', () => {
  it('delivers a packet from the hub over the hub certificate', () => {
    const { t, delivered } = rig({ hubOnlyPeers: true })
    t.onIncomingMessage(
      'REQ',
      packet({ sender: 'hub', action: '$agent.health' }),
      tlsSocketOf('hub'),
    )
    expect(delivered).toHaveLength(1)
  })

  it.each([
    ['no sender', { action: '$agent.deploy' }],
    ['a non-string sender', { sender: 42, action: '$agent.deploy' }],
    ['an empty sender', { sender: '', action: '$agent.deploy' }],
    ['the receiver as its own sender', { sender: OWN, action: '$process.spawnRunner' }],
  ])('over a verified TLS socket: %s', (_name, payload) => {
    const { t, delivered, warnings } = rig({ hubOnlyPeers: true })
    t.onIncomingMessage('REQ', packet(payload), tlsSocketOf('hub'))
    expect(delivered).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('a sender that is not the certificate CN is still dropped', () => {
    const { t, delivered } = rig({ hubOnlyPeers: true })
    t.onIncomingMessage('REQ', packet({ sender: 'someone-else' }), tlsSocketOf('hub'))
    expect(delivered).toHaveLength(0)
  })

  it.each([
    ['no sender', { action: '$process.spawnRunner' }],
    ['the receiver as its own sender', { sender: OWN, action: '$process.spawnRunner' }],
  ])('on any other transporter and socket: %s', (_name, payload) => {
    const { t, delivered } = rig({ hubOnlyPeers: false })
    t.onIncomingMessage('REQ', packet(payload), undefined)
    expect(delivered).toHaveLength(0)
  })
})
