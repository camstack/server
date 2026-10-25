import { describe, it, expect, afterEach } from 'vitest'
import { startTurnServer, type TurnTestServer } from '../turn-test-server.js'

describe('startTurnServer', () => {
  let srv: TurnTestServer | null = null
  afterEach(async () => {
    await srv?.stop()
    srv = null
  })

  it('starts a loopback TURN server and reports its ICE server config', async () => {
    srv = await startTurnServer()
    expect(srv.iceServer.urls).toMatch(/^turn:127\.0\.0\.1:\d+/)
    expect(srv.iceServer.username).toBe('camstack')
    expect(srv.iceServer.credential).toBe('camstack')
  })
})
