import { describe, it, expect, afterEach } from 'vitest'
import { startTurnServer, type TurnTestServer } from '../turn-test-server.js'
import { createRelayPeer } from '../relay-peer.js'

/**
 * Extract every ICE candidate's `typ <type>` token from an SDP blob.
 *
 * A candidate line looks like:
 *   `a=candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> ...`
 * We only care about the `<type>` (`host` | `srflx` | `prflx` | `relay`). The
 * non-greedy prefix tolerates any field ordering werift uses before `typ`.
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
 * Gather a relay-only peer against the local TURN server and return the ICE
 * candidate types its SDP carries. With `iceTransportPolicy: 'relay'` set on
 * the peer (see {@link createRelayPeer}), a CORRECT implementation must emit
 * ONLY `relay` candidates — any `host`/`srflx` line is the upstream forceTurn
 * candidate leak.
 */
async function relayOnlySdpTypes(
  wrtc: typeof import('werift'),
  turn: TurnTestServer,
): Promise<string[]> {
  const peer = await createRelayPeer(wrtc, turn.iceServer, 'sender')
  try {
    const sdp = await peer.localDescription()
    return candidateTypes(sdp)
  } finally {
    await peer.close()
  }
}

describe('relay-only policy emits relay-only SDP candidates (werift forceTurn leak)', () => {
  let turn: TurnTestServer | null = null
  afterEach(async () => {
    await turn?.stop()
    turn = null
  })

  it('patched upstream werift emits only relay candidates under iceTransportPolicy:relay', async () => {
    turn = await startTurnServer()
    const types = await relayOnlySdpTypes(await import('werift'), turn)
    expect(types.length).toBeGreaterThan(0) // a relay candidate WAS gathered
    expect(types.every((t) => t === 'relay')).toBe(true) // NO host/srflx leak — RED pre-patch, GREEN post-patch
  }, 30_000)

  it('koush fork emits only relay candidates (oracle)', async () => {
    turn = await startTurnServer()
    // Documented test-boundary cast: @koush/werift 0.17's published types differ from
    // upstream 0.22's, but the runtime ICE/SDP API the helper uses is compatible.
    const types = await relayOnlySdpTypes(
      (await import('@koush/werift')) as unknown as typeof import('werift'),
      turn,
    )
    expect(types.every((t) => t === 'relay')).toBe(true)
  }, 30_000)
})
