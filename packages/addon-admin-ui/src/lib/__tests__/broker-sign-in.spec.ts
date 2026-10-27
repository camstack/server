/**
 * A sign-in answer that is not JSON (a proxy page, a 404 shell) must surface as a
 * readable error naming the step and the HTTP status — not the browser's raw
 * JSON parse message ("The string did not match the expected pattern").
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBrokerSignInStatus, startBrokerSignIn } from '../broker-sign-in'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(response: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  )
}

describe('broker sign-in client', () => {
  it('names the step and status when the start answer is not JSON', async () => {
    stubFetch(new Response('<html>nope</html>', { status: 404 }))
    await expect(startBrokerSignIn('/addon/x/login', {})).rejects.toThrow(
      'Sign-in start failed: HTTP 404',
    )
  })

  it('names the status when the poll answer is not JSON', async () => {
    stubFetch(new Response('<html>nope</html>', { status: 502 }))
    await expect(getBrokerSignInStatus('/addon/x/login', 's1')).rejects.toThrow(
      'Sign-in status failed: HTTP 502',
    )
  })

  it('still reads a JSON answer', async () => {
    stubFetch(Response.json({ sessionId: 's1', loginUrl: '/u' }))
    await expect(startBrokerSignIn('/addon/x/login', {})).resolves.toEqual({
      sessionId: 's1',
      loginUrl: '/u',
    })
  })
})
