/**
 * A run-action button that asks for CONFIRMATION (planning#669): the tap opens
 * a page, and only the page's POST (`confirm=1`) claims the token and runs the
 * Action. One accidental tap on a push notification must never unlock a door.
 */

import type { ServerResponse } from 'node:http'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { NcActionPlane } from '../action-plane.js'
import { NcActionTokenRegistry, type NcRunActionGrant, signActionToken } from '../action-token.js'

const SECRET = 'per-install'
const NOW = 1_000

interface Captured {
  status: number
  body: string
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '' }
  const res = {
    writeHead: (status: number) => {
      captured.status = status
    },
    end: (body: string) => {
      captured.body = body
    },
  }
  // The handler uses only writeHead/end; documented type boundary.
  return { res: res as unknown as ServerResponse, captured }
}

function loggerWith(warn: ReturnType<typeof vi.fn>): IScopedLogger {
  const noop = vi.fn()
  return { info: noop, warn, error: noop, debug: noop } as unknown as IScopedLogger
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

function setup(g: NcRunActionGrant, run: () => Promise<void>) {
  const registry = new NcActionTokenRegistry(() => NOW)
  registry.put(g)
  const warn = vi.fn()
  const plane = new NcActionPlane({
    registry,
    secret: SECRET,
    logger: loggerWith(warn),
    run,
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
    await plane.handler({ url: baseUrl(), method: 'GET' } as never, res)
    expect(captured.status).toBe(200)
    expect(captured.body).toContain('Unlock door')
    expect(captured.body).toContain('method="post"')
    expect(run).not.toHaveBeenCalled()
    expect(registry.peek('tok1').ok).toBe(true)
  })

  it('a background POST (no confirm=1) is refused: nothing runs, token kept, device logged', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane, registry, warn } = setup(confirmGrant, run)
    const { res } = fakeRes()
    await plane.handler({ url: baseUrl(), method: 'POST' } as never, res)
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
    await plane.handler({ url: `${baseUrl()}&confirm=1`, method: 'POST' } as never, first.res)
    expect(run).toHaveBeenCalledTimes(1)
    expect(first.captured.body).toContain('Done')
    const second = fakeRes()
    await plane.handler({ url: `${baseUrl()}&confirm=1`, method: 'POST' } as never, second.res)
    expect(run).toHaveBeenCalledTimes(1)
    expect(second.captured.body).toContain('Already done')
  })

  it('a plain run-action button is unchanged: a GET still runs it', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setup(grant(), run)
    const { res } = fakeRes()
    await plane.handler({ url: baseUrl(), method: 'GET' } as never, res)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
