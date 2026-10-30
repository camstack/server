/**
 * The dial listener, on a REAL loopback socket.
 *
 * Nothing is mocked below the HTTP layer: the listener binds, `node:http`
 * dials it, and the assertions are on what came back over TCP. A fake server
 * would have proved the map, which is not the part that can be wrong.
 */
import { get, request } from 'node:http'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ClipStreamRouteOutcome, ClipStreamTarget } from '../clip-data-plane.js'
import { type ClipStreamDial, createClipStreamDial } from '../clip-stream-dial.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

const TARGET: ClipStreamTarget = { deviceId: 3833, clipKey: 'b'.repeat(40), audio: 'pcmu' }

interface Fetched {
  readonly status: number
  readonly code: string | undefined
  readonly body: string
  readonly transport: string | undefined
  readonly contentType: string | undefined
}

function fetchUrl(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = method === 'GET' ? get(url) : request(url, { method })
    req.on('response', (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          code: res.headers['x-camstack-reason-code']?.toString(),
          transport: res.headers['x-camstack-clip-transport']?.toString(),
          contentType: res.headers['content-type']?.toString(),
          body,
        }),
      )
    })
    req.on('error', reject)
    if (method !== 'GET') req.end()
  })
}

let open: ClipStreamDial | null = null
afterEach(async () => {
  await open?.dispose()
  open = null
})

function dialWith(
  stream: (target: ClipStreamTarget) => Promise<ClipStreamRouteOutcome>,
  options: { ttlMs?: number; maxOutstanding?: number; now?: () => number } = {},
): ClipStreamDial {
  const dial = createClipStreamDial({
    logger,
    stream: async (target, sink) => {
      const outcome = await stream(target)
      if (outcome.kind === 'served') {
        sink.begin('video/quicktime')
        sink.write(Buffer.from('ftypqt  '))
        sink.end()
      }
      return outcome
    },
    ...options,
  })
  open = dial
  return dial
}

describe('the clip stream dial', () => {
  it('serves the clip the token was minted for, once', async () => {
    const seen: ClipStreamTarget[] = []
    const dial = dialWith(async (target) => {
      seen.push(target)
      return { kind: 'served' }
    })
    const ticket = await dial.mint(TARGET)
    expect(ticket.kind).toBe('ticket')
    if (ticket.kind !== 'ticket') return
    expect(ticket.url.startsWith('http://127.0.0.1:')).toBe(true)
    expect(dial.outstanding).toBe(1)

    const first = await fetchUrl(ticket.url)
    expect(first.status).toBe(200)
    expect(first.body).toBe('ftypqt  ')
    // The route's own statement of what it is. A consumer that dials and does
    // not read this back would play a forward-only feed as a seekable file.
    expect(first.transport).toBe('forward-only')
    // The container comes from the MUX, not from a constant: a µ-law stream
    // is QuickTime.
    expect(first.contentType).toBe('video/quicktime')
    expect(seen).toEqual([TARGET])
    expect(dial.outstanding).toBe(0)

    const second = await fetchUrl(ticket.url)
    expect(second.status).toBe(410)
    expect(second.code).toBe('dial-used')
    // The camera is touched once per dial, and a replay reaches no route.
    expect(seen).toHaveLength(1)
  })

  it('answers `dial-unknown` for a token nobody minted', async () => {
    const dial = dialWith(async () => ({ kind: 'served' }))
    const ticket = await dial.mint(TARGET)
    if (ticket.kind !== 'ticket') return
    const base = ticket.url.slice(0, ticket.url.lastIndexOf('/'))
    const answer = await fetchUrl(`${base}/not-a-token`)
    expect(answer.status).toBe(404)
    expect(answer.code).toBe('dial-unknown')
  })

  it('expires a dial nobody took', async () => {
    let clock = 1_000
    const dial = dialWith(async () => ({ kind: 'served' }), {
      ttlMs: 50,
      now: () => clock,
    })
    const ticket = await dial.mint(TARGET)
    if (ticket.kind !== 'ticket') return
    clock += 51
    const answer = await fetchUrl(ticket.url)
    expect(answer.status).toBe(410)
    expect(answer.code).toBe('dial-expired')
  })

  it('HEAD looks and leaves the dial where it was', async () => {
    const dial = dialWith(async () => ({ kind: 'served' }))
    const ticket = await dial.mint(TARGET)
    if (ticket.kind !== 'ticket') return
    const head = await fetchUrl(ticket.url, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.transport).toBe('forward-only')
    expect(dial.outstanding).toBe(1)
    expect((await fetchUrl(ticket.url)).status).toBe(200)
  })

  it('bounds the dials a caller may mint and never take', async () => {
    const dial = dialWith(async () => ({ kind: 'served' }), { maxOutstanding: 2 })
    expect((await dial.mint(TARGET)).kind).toBe('ticket')
    expect((await dial.mint(TARGET)).kind).toBe('ticket')
    const refused = await dial.mint(TARGET)
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    expect(refused.code).toBe('dial-exhausted')
  })

  it('carries the route’s refusal, with its reason, as a status', async () => {
    const dial = dialWith(async () => ({
      kind: 'refused',
      code: 'no-catalog-row',
      detail: 'no-catalog-row: list this window before asking for its stream',
    }))
    const ticket = await dial.mint(TARGET)
    if (ticket.kind !== 'ticket') return
    const answer = await fetchUrl(ticket.url)
    expect(answer.status).toBe(404)
    expect(answer.code).toBe('no-catalog-row')
  })

  it('releases the port on dispose', async () => {
    const dial = dialWith(async () => ({ kind: 'served' }))
    const ticket = await dial.mint(TARGET)
    if (ticket.kind !== 'ticket') return
    await dial.dispose()
    open = null
    await expect(fetchUrl(ticket.url)).rejects.toThrow()
  })
})
