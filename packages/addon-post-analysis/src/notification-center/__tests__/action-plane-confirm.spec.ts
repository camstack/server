/**
 * A run-action button that asks for CONFIRMATION (planning#669): the tap opens
 * a page, and only the page's POST (`confirm=1`) claims the token and runs the
 * Action. One accidental tap on a push notification must never unlock a door.
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { mergeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcActionPlane } from '../action-plane.js'
import { NcActionTokenRegistry, type NcRunActionGrant, signActionToken } from '../action-token.js'

const SECRET = 'per-install'
const NOW = 1_000

/** A real response whose writes are kept instead of sent. */
class CapturingResponse extends ServerResponse {
  status = 0
  body = ''
  override writeHead(statusCode: number): this {
    this.status = statusCode
    return this
  }
  override end(chunk?: unknown): this {
    this.body = typeof chunk === 'string' ? chunk : ''
    return this
  }
}

/** A real request carrying only what the plane reads: the url and the method. */
function requestOf(url: string, method: 'GET' | 'POST'): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.url = url
  req.method = method
  return req
}

function fakeRes(): { res: CapturingResponse; captured: CapturingResponse } {
  const res = new CapturingResponse(requestOf('/', 'GET'))
  return { res, captured: res }
}

const grant = (over: Partial<NcRunActionGrant> = {}): NcRunActionGrant => ({
  kind: 'run-action',
  id: 'tok1',
  ruleId: 'r1',
  ruleName: 'Gate at night',
  runActionId: 'internal:open-gate',
  deviceId: 101,
  actionId: 'open',
  expiresAt: NOW + 60_000,
  ...over,
})

const baseUrl = (): string =>
  `/addon/x/nc-action/tok1?exp=${NOW + 60_000}&sig=${signActionToken(SECRET, 'tok1', NOW + 60_000)}`

function setup(
  g: NcRunActionGrant,
  run: () => Promise<void>,
  deviceName?: (deviceId: number) => string | undefined,
) {
  const registry = new NcActionTokenRegistry(() => NOW)
  registry.put(g)
  const warn = vi.fn()
  const plane = new NcActionPlane({
    registry,
    secret: SECRET,
    logger: mergeSilentLogger({ warn }),
    run,
    ...(deviceName !== undefined ? { deviceName } : {}),
    now: () => NOW,
  })
  return { registry, plane, warn }
}

describe('a confirm button asks on a page before it runs', () => {
  const confirmGrant = grant({ confirm: true, label: 'Unlock door' })

  it('a GET renders the confirm page naming the button, and spends nothing', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane, registry } = setup(confirmGrant, run)
    const { res, captured } = fakeRes()
    await plane.handler(requestOf(baseUrl(), 'GET'), res)
    expect(captured.status).toBe(200)
    expect(captured.body).toContain('Unlock door')
    expect(captured.body).toContain('method="post"')
    expect(run).not.toHaveBeenCalled()
    expect(registry.peek('tok1').ok).toBe(true)
  })

  it('the confirm page names the device, not its numeric id', async () => {
    const { plane } = setup(
      confirmGrant,
      vi.fn(() => Promise.resolve()),
      (id) => (id === 101 ? 'Front gate' : undefined),
    )
    const { res, captured } = fakeRes()
    await plane.handler(requestOf(baseUrl(), 'GET'), res)
    expect(captured.body).toContain('Unlock door')
    expect(captured.body).toContain('Front gate')
    expect(captured.body).not.toContain('101')
  })

  it('the confirm page falls back to the id only when the name is unknown', async () => {
    const { plane } = setup(
      confirmGrant,
      vi.fn(() => Promise.resolve()),
      () => undefined,
    )
    const { res, captured } = fakeRes()
    await plane.handler(requestOf(baseUrl(), 'GET'), res)
    expect(captured.body).toContain('device 101')
  })

  it('a device name is escaped on the page', async () => {
    const { plane } = setup(
      confirmGrant,
      vi.fn(() => Promise.resolve()),
      () => '<b>Gate</b>',
    )
    const { res, captured } = fakeRes()
    await plane.handler(requestOf(baseUrl(), 'GET'), res)
    expect(captured.body).toContain('&lt;b&gt;Gate&lt;/b&gt;')
  })

  it('a background POST (no confirm=1) is refused: nothing runs, token kept, device logged', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane, registry, warn } = setup(confirmGrant, run)
    const { res } = fakeRes()
    await plane.handler(requestOf(baseUrl(), 'POST'), res)
    expect(run).not.toHaveBeenCalled()
    expect(registry.peek('tok1').ok).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('confirm'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('a POST with confirm=1 runs once, and a second POST is refused', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setup(confirmGrant, run)
    const first = fakeRes()
    await plane.handler(requestOf(`${baseUrl()}&confirm=1`, 'POST'), first.res)
    expect(run).toHaveBeenCalledTimes(1)
    expect(first.captured.body).toContain('Done')
    const second = fakeRes()
    await plane.handler(requestOf(`${baseUrl()}&confirm=1`, 'POST'), second.res)
    expect(run).toHaveBeenCalledTimes(1)
    expect(second.captured.body).toContain('Already done')
  })

  it('a plain run-action button is unchanged: a GET still runs it', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setup(grant(), run)
    const { res } = fakeRes()
    await plane.handler(requestOf(baseUrl(), 'GET'), res)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
