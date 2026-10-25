import { describe, it, expect } from 'vitest'
import { startTurnServer } from '../turn-test-server.js'
import { createRelayPeer } from '../relay-peer.js'

/** Send RTP sender→receiver over a relay-only path for ~3s; resolve received packet count. */
async function relayMediaCount(wrtc: typeof import('werift')): Promise<number> {
  const turn = await startTurnServer()
  let received = 0
  const recv = await createRelayPeer(wrtc, turn.iceServer, 'receiver')
  const send = await createRelayPeer(wrtc, turn.iceServer, 'sender')
  recv.onRtpLen(() => {
    received += 1
  })
  // manual signaling: sender offer → receiver remote → receiver answer → sender remote
  await recv.setRemote(await send.localDescription())
  await send.setRemote(await recv.localDescription())
  const payload = new Uint8Array(1000).fill(7)
  const timer = setInterval(() => send.sendRtp(payload), 50)
  await new Promise((r) => setTimeout(r, 3000))
  clearInterval(timer)
  await send.close()
  await recv.close()
  await turn.stop()
  return received
}

describe('relay-only media (the werift TURN bug)', () => {
  it('upstream werift forwards media over a TURN relay', async () => {
    const wrtc = await import('werift')
    const count = await relayMediaCount(wrtc)
    expect(count).toBeGreaterThan(10)
  }, 30_000)

  it('koush fork forwards media over a TURN relay (oracle)', async () => {
    // Documented test-boundary cast: @koush/werift 0.17's published types differ from
    // upstream 0.22's, but the runtime media API the helper uses is compatible.
    const wrtc = (await import('@koush/werift')) as unknown as typeof import('werift')
    const count = await relayMediaCount(wrtc)
    expect(count).toBeGreaterThan(10) // koush is the known-good oracle for the relay path
  }, 30_000)
})
