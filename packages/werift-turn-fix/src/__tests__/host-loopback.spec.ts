import { describe, it, expect } from 'vitest'
import { createRelayPeer, type IceServer } from '../relay-peer.js'

/**
 * Extract every ICE candidate type from an SDP blob (same regex as relay-sdp-policy.spec.ts).
 *
 * A candidate line looks like:
 *   `a=candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> ...`
 */
function candidateTypes(sdp: string): string[] {
  const types: string[] = []
  for (const m of sdp.matchAll(/a=candidate:\S+ \d+ \S+ \d+ \S+ \d+ typ (\w+)/g)) {
    const type = m[1]
    if (type) types.push(type)
  }
  return types
}

/**
 * Dummy ICE server descriptor — unused at runtime because `options.iceServers: []`
 * passes no servers to the PC. Required by the `createRelayPeer` positional
 * signature; the helper ignores it when `options.iceServers` is provided.
 */
const DUMMY_ICE_SERVER: IceServer = { urls: 'turn:127.0.0.1:1' }

/**
 * Send RTP sender→receiver over a plain host path for ~3s; resolve the
 * received packet count AND the sender's ICE candidate types from its SDP.
 *
 * Both peers use `policy: 'all'` with no TURN/STUN server so only loopback
 * host candidates are gathered — the direct inverse of the relay-only path.
 */
async function hostMediaCount(wrtc: typeof import('werift')): Promise<{
  count: number
  senderCandidateTypes: string[]
}> {
  const hostOptions = { policy: 'all' as const, iceServers: [] as IceServer[] }

  const recv = await createRelayPeer(wrtc, DUMMY_ICE_SERVER, 'receiver', hostOptions)
  const send = await createRelayPeer(wrtc, DUMMY_ICE_SERVER, 'sender', hostOptions)

  let received = 0
  recv.onRtpLen(() => {
    received += 1
  })

  // Manual signaling: sender offer → receiver remote → receiver answer → sender remote.
  const senderSdp = await send.localDescription()
  await recv.setRemote(senderSdp)
  await send.setRemote(await recv.localDescription())

  const senderCandidateTypes = candidateTypes(senderSdp)

  const payload = new Uint8Array(1000).fill(7)
  const timer = setInterval(() => send.sendRtp(payload), 50)
  await new Promise((r) => setTimeout(r, 3000))
  clearInterval(timer)
  await send.close()
  await recv.close()

  return { count: received, senderCandidateTypes }
}

describe('host-path regression guard (patch must NOT break LAN / default policy)', () => {
  it('patched upstream werift forwards media on the host path (policy:all, no TURN)', async () => {
    const wrtc = await import('werift')
    const { count, senderCandidateTypes } = await hostMediaCount(wrtc)

    // Media MUST flow on the direct loopback host path.
    expect(count).toBeGreaterThan(10)

    // The SDP MUST contain host candidates — proving the patch only strips
    // candidates under forceTurn (relay policy), not under the default 'all' policy.
    expect(senderCandidateTypes).toContain('host')
  }, 30_000)
})
