import { describe, it, expect, vi } from 'vitest'
import { callWithServiceDiscovery } from '../../moleculer/resilient-cap-call.js'

/** A Moleculer-ServiceNotFound-shaped error. */
function serviceNotFound(): Error & { code: number; type: string } {
  const e = new Error("Service 'x' is not found.") as Error & { code: number; type: string }
  e.code = 404
  e.type = 'SERVICE_NOT_FOUND'
  return e
}
function serviceNotAvailable(): Error & { code: number; type: string } {
  const e = new Error("Service 'x' is not available.") as Error & { code: number; type: string }
  e.code = 503
  e.type = 'SERVICE_NOT_AVAILABLE'
  return e
}

/** Broker stub: `call` plays a scripted outcome queue; `waitForServices` records + resolves/rejects. */
function brokerStub(callOutcomes: Array<'ok' | Error>, waitRejects = false) {
  let i = 0
  const calls: string[] = []
  const waited: string[][] = []
  return {
    calls,
    waited,
    broker: {
      call: vi.fn((action: string) => {
        calls.push(action)
        const o = callOutcomes[i++] ?? 'ok'
        return o === 'ok' ? Promise.resolve({ ok: true }) : Promise.reject(o)
      }),
      waitForServices: vi.fn((services: string[]) => {
        waited.push(services)
        return waitRejects
          ? Promise.reject(new Error('waitForServices timeout'))
          : Promise.resolve()
      }),
    },
  }
}

describe('callWithServiceDiscovery', () => {
  it('returns the result directly when the first call succeeds — no waitForServices', async () => {
    const { broker, calls, waited } = brokerStub(['ok'])
    const r = await callWithServiceDiscovery(
      broker as never,
      'admin-ui',
      'admin-ui.admin-ui.getStaticDir',
      {},
      {},
    )
    expect(r).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(waited).toHaveLength(0)
  })

  it('on SERVICE_NOT_FOUND: waits for the service then retries once and succeeds', async () => {
    const { broker, calls, waited } = brokerStub([serviceNotFound(), 'ok'])
    const r = await callWithServiceDiscovery(
      broker as never,
      'admin-ui',
      'admin-ui.admin-ui.getStaticDir',
      {},
      {},
    )
    expect(r).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(waited).toEqual([['admin-ui']])
  })

  it('on SERVICE_NOT_AVAILABLE: also waits + retries', async () => {
    const { broker, calls, waited } = brokerStub([serviceNotAvailable(), 'ok'])
    await callWithServiceDiscovery(
      broker as never,
      'cloudflare-tunnel',
      'cloudflare-tunnel.network-access.start',
      {},
      {},
    )
    expect(calls).toHaveLength(2)
    expect(waited).toEqual([['cloudflare-tunnel']])
  })

  it('a non-discovery error is rethrown immediately — no wait, no retry', async () => {
    const boom = new Error('boom')
    const { broker, calls, waited } = brokerStub([boom])
    await expect(callWithServiceDiscovery(broker as never, 'x', 'x.cap.m', {}, {})).rejects.toThrow(
      'boom',
    )
    expect(calls).toHaveLength(1)
    expect(waited).toHaveLength(0)
  })

  it('if waitForServices rejects (service never appears), the rejection surfaces — fail-fast', async () => {
    const { broker } = brokerStub([serviceNotFound(), 'ok'], true)
    await expect(callWithServiceDiscovery(broker as never, 'x', 'x.cap.m', {}, {})).rejects.toThrow(
      /timeout/i,
    )
  })

  it('retries at most once — a second SERVICE_NOT_FOUND after the wait surfaces', async () => {
    const { broker, calls } = brokerStub([serviceNotFound(), serviceNotFound()])
    await expect(
      callWithServiceDiscovery(broker as never, 'x', 'x.cap.m', {}, {}),
    ).rejects.toMatchObject({ type: 'SERVICE_NOT_FOUND' })
    expect(calls).toHaveLength(2)
  })
})
