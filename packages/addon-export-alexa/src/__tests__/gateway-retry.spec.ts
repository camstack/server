/**
 * R3 — the Event Gateway retry rule Amazon gives (smarthome/send-events):
 * 429 / 500 / 503 and network failures are re-sent up to three times, at
 * least one second apart; everything else is final at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GATEWAY_RETRY_DELAYS_MS, sendWithGatewayRetry } from '../lwa-event-gateway.js'

const resp = (status: number, headers: Record<string, string> = {}) =>
  ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers) }) as Response

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('sendWithGatewayRetry', () => {
  it('retries a 503 and a throttle, then returns the 202', async () => {
    const answers = [resp(503), resp(429), resp(202)]
    const attempt = vi.fn(async () => answers.shift() ?? resp(500))
    const retries: number[] = []
    const p = sendWithGatewayRetry(attempt, (_n, _r, delay) => retries.push(delay))
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await p).status).toBe(202)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(retries).toEqual([1_000, 2_000])
  })

  it('gives up after three retries and returns the last answer', async () => {
    const attempt = vi.fn(async () => resp(503))
    const p = sendWithGatewayRetry(attempt, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect((await p).status).toBe(503)
    expect(attempt).toHaveBeenCalledTimes(1 + GATEWAY_RETRY_DELAYS_MS.length)
  })

  it('never retries a 400, 401 or 403', async () => {
    for (const status of [400, 401, 403]) {
      const attempt = vi.fn(async () => resp(status))
      expect((await sendWithGatewayRetry(attempt, () => {})).status).toBe(status)
      expect(attempt).toHaveBeenCalledTimes(1)
    }
  })

  it('retries a network failure, and honours Retry-After (capped)', async () => {
    let n = 0
    const attempt = vi.fn(async () => {
      n += 1
      if (n === 1) throw new Error('ECONNRESET')
      if (n === 2) return resp(429, { 'retry-after': '3' })
      return resp(202)
    })
    const delays: number[] = []
    const p = sendWithGatewayRetry(attempt, (_n, _r, d) => delays.push(d))
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await p).status).toBe(202)
    expect(delays).toEqual([1_000, 3_000])
  })
})
