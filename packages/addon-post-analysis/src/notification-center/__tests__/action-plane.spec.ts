/**
 * The public route a notification button lands on.
 *
 * What is asserted here is not "does it render a page" but the four things that
 * make it safe to expose at all: a forged link learns nothing, a valid link
 * runs exactly once, a failed run does NOT hand the token back, and every
 * outcome leaves a line.
 */

import type { ServerResponse } from 'node:http'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { NcActionPlane } from '../action-plane.js'
import { NcActionTokenRegistry, type NcSequenceGrant, signActionToken } from '../action-token.js'

const SECRET = 'per-install'
const NOW = 1_000

interface Captured {
  status: number
  body: string
  headers: Record<string, unknown>
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '', headers: {} }
  const res = {
    writeHead: (status: number, headers: Record<string, unknown>) => {
      captured.status = status
      captured.headers = headers
    },
    end: (body: string) => {
      captured.body = body
    },
  }
  // The handler uses only writeHead/end; a full ServerResponse is not
  // constructible in a unit test. Documented type boundary.
  return { res: res as unknown as ServerResponse, captured }
}

function fakeLogger(): IScopedLogger {
  const noop = vi.fn()
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => fakeLogger(),
  } as unknown as IScopedLogger
}

const grant = (over: Partial<NcSequenceGrant> = {}): NcSequenceGrant => ({
  kind: 'sequence',
  id: 'tok1',
  ruleId: 'r1',
  ruleName: 'Gate at night',
  sequenceId: 'open-gate-id',
  deviceId: 101,
  actionId: 'open',
  expiresAt: NOW + 60_000,
  ...over,
})

function urlFor(id: string, exp: number, secret = SECRET): string {
  return `/addon/x/nc-action/${id}?exp=${exp}&sig=${signActionToken(secret, id, exp)}`
}

function setup(run: () => Promise<void>) {
  const registry = new NcActionTokenRegistry(() => NOW)
  registry.put(grant())
  const plane = new NcActionPlane({
    registry,
    secret: SECRET,
    logger: fakeLogger(),
    run,
    now: () => NOW,
  })
  return { registry, plane }
}

describe('a forged or stale link learns nothing', () => {
  it('404s a bad signature without touching the registry', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setup(run)
    const { res, captured } = fakeRes()
    await plane.handler(
      { url: `/addon/x/nc-action/tok1?exp=${NOW + 60_000}&sig=deadbeef` } as never,
      res,
    )
    expect(captured.status).toBe(404)
    expect(run).not.toHaveBeenCalled()
  })

  it("404s another install's signature", async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setup(run)
    const { res, captured } = fakeRes()
    await plane.handler({ url: urlFor('tok1', NOW + 60_000, 'other-install') } as never, res)
    expect(captured.status).toBe(404)
    expect(run).not.toHaveBeenCalled()
  })

  it('gives an UNKNOWN id the same 404 as a forgery — no oracle', async () => {
    // The id is signed correctly but was never minted. It must be
    // indistinguishable from a bad signature at the status level.
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setup(run)
    const { res: r1, captured: forged } = fakeRes()
    await plane.handler({ url: `/addon/x/nc-action/tok1?exp=1&sig=nope` } as never, r1)
    const { res: r2, captured: unknownId } = fakeRes()
    await plane.handler({ url: urlFor('never-minted', NOW + 60_000) } as never, r2)
    // A correctly-signed unknown id gets the human page (the caller proved they
    // hold OUR link); a forgery gets the flat 404.
    expect(forged.status).toBe(404)
    expect(unknownId.body).toContain('no longer available')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('exactly once', () => {
  it('runs the sequence on the first tap', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setup(run)
    const { res, captured } = fakeRes()
    await plane.handler({ url: urlFor('tok1', NOW + 60_000) } as never, res)
    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.status).toBe(200)
    expect(captured.body).toContain('Done')
    // Named by the rule and the button tapped — never `undefined`.
    expect(captured.body).toContain('Gate at night — open')
    expect(captured.body).not.toContain('undefined')
  })

  it('does NOT run it again on a second tap', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setup(run)
    const { res: r1 } = fakeRes()
    await plane.handler({ url: urlFor('tok1', NOW + 60_000) } as never, r1)
    const { res: r2, captured } = fakeRes()
    await plane.handler({ url: urlFor('tok1', NOW + 60_000) } as never, r2)
    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.body).toContain('Already done')
  })

  it('does not hand the token back when the sequence FAILS', async () => {
    // Retrying a half-run "unlock, wait, open" executes an intent nobody
    // expressed. The spend is the point.
    const run = vi.fn(() => Promise.reject(new Error('gate offline')))
    const { plane } = setup(run)
    const { res: r1, captured: first } = fakeRes()
    await plane.handler({ url: urlFor('tok1', NOW + 60_000) } as never, r1)
    expect(first.body).toContain('did not work')

    const { res: r2, captured: second } = fakeRes()
    await plane.handler({ url: urlFor('tok1', NOW + 60_000) } as never, r2)
    expect(run).toHaveBeenCalledTimes(1)
    expect(second.body).toContain('Already done')
  })

  it('never lets a failure escape as a 500', async () => {
    // The caller is an in-app browser; an unhandled throw would render its own
    // error screen and the operator would learn nothing about the gate.
    const run = vi.fn(() => Promise.reject(new Error('boom')))
    const { plane } = setup(run)
    const { res, captured } = fakeRes()
    await expect(
      plane.handler({ url: urlFor('tok1', NOW + 60_000) } as never, res),
    ).resolves.toBeUndefined()
    expect(captured.status).toBe(200)
  })
})

describe('the response is never cached', () => {
  it('sends no-store, so a replayed page cannot claim a tap happened', async () => {
    const { plane } = setup(() => Promise.resolve())
    const { res, captured } = fakeRes()
    await plane.handler({ url: urlFor('tok1', NOW + 60_000) } as never, res)
    expect(String(captured.headers['cache-control'])).toContain('no-store')
  })
})

describe('a BACKGROUND call is answered in the shape it can use', () => {
  function setupSnooze(run: () => Promise<void>) {
    const registry = new NcActionTokenRegistry(() => NOW)
    registry.put({
      kind: 'snooze',
      id: 'tok-s',
      ruleId: 'r1',
      ruleName: 'Gate at night',
      userId: 'user-bob',
      minutes: 30,
      classes: ['cat'],
      deviceId: 102,
      actionId: 'snooze-30',
      expiresAt: NOW + 60_000,
    })
    const plane = new NcActionPlane({
      registry,
      secret: SECRET,
      logger: fakeLogger(),
      run,
      now: () => NOW,
    })
    return { registry, plane }
  }

  it('answers a POST with text/plain, not an HTML document', async () => {
    // The phone fires this without leaving the notification; handing it a page
    // means an OS parsing (and sometimes rendering) a document for a tap that
    // was meant to be invisible.
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setupSnooze(run)
    const { res, captured } = fakeRes()
    await plane.handler({ method: 'POST', url: urlFor('tok-s', NOW + 60_000) } as never, res)
    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.headers['content-type']).toContain('text/plain')
    expect(captured.body).not.toContain('<!doctype')
    expect(captured.body).toContain('30 min')
    expect(captured.body).toContain('cat')
  })

  it('CONTROL — the same grant over GET still renders the page', async () => {
    const run = vi.fn(() => Promise.resolve())
    const { plane } = setupSnooze(run)
    const { res, captured } = fakeRes()
    await plane.handler({ method: 'GET', url: urlFor('tok-s', NOW + 60_000) } as never, res)
    expect(captured.headers['content-type']).toContain('text/html')
    expect(captured.body).toContain('<!doctype')
  })

  it('describes an ALARM grant as an alarm, not as a sequence', async () => {
    const registry = new NcActionTokenRegistry(() => NOW)
    registry.put({
      kind: 'alarm',
      id: 'tok-a',
      action: 'disarm',
      panelDeviceId: 900,
      deviceId: 900,
      actionId: 'alarm-disarm',
      expiresAt: NOW + 60_000,
    })
    const plane = new NcActionPlane({
      registry,
      secret: SECRET,
      logger: fakeLogger(),
      run: () => Promise.resolve(),
      now: () => NOW,
    })
    const { res, captured } = fakeRes()
    await plane.handler({ url: urlFor('tok-a', NOW + 60_000) } as never, res)
    expect(captured.body).toContain('Alarm disarmed')
  })
})
