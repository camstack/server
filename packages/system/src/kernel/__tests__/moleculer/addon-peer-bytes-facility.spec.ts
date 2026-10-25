/**
 * The addon→addon byte transport (D613), driven through REAL loopback sockets.
 *
 * There are no fakes here on purpose. The bug this facility exists partly to
 * make unrepeatable — the head of a stream thrown away because Node flushed the
 * body it already held on the tick BEFORE the consumer was ready (D597) —
 * survived fourteen green unit tests whose fake opener only ever delivered
 * after the `await`. A fake cannot reproduce it. A socket can.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

import type { IScopedLogger, PeerBytesTicket } from '@camstack/types'

import {
  createAddonPeerBytesFacility,
  hostNodeIdOf,
  type AddonPeerBytesFacility,
} from '../../moleculer/addon-peer-bytes-facility.js'

interface Line {
  readonly message: string
  readonly deviceId: number | undefined
  readonly meta: Record<string, unknown>
}

interface Harness {
  readonly facility: AddonPeerBytesFacility
  readonly info: Line[]
  readonly warn: Line[]
}

function harness(
  options: { nodeId?: string; stallMs?: number; ttlMs?: number; maxOutstanding?: number } = {},
): Harness {
  const info: Line[] = []
  const warn: Line[] = []
  const record =
    (sink: Line[]) =>
    (message: string, ctx?: unknown): void => {
      const holder = typeof ctx === 'object' && ctx !== null ? (ctx as Record<string, unknown>) : {}
      const tags = holder['tags']
      const deviceId =
        typeof tags === 'object' && tags !== null
          ? (tags as Record<string, unknown>)['deviceId']
          : undefined
      const meta = holder['meta']
      sink.push({
        message,
        deviceId: typeof deviceId === 'number' ? deviceId : undefined,
        meta: typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {},
      })
    }
  const logger: IScopedLogger = {
    info: record(info),
    warn: record(warn),
    error: record(warn),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const facility = createAddonPeerBytesFacility({
    addonId: 'provider-under-test',
    logger,
    nodeId: options.nodeId ?? 'hub/runner-1',
    ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.maxOutstanding !== undefined ? { maxOutstanding: options.maxOutstanding } : {}),
  })
  return { facility, info, warn }
}

async function drain(ticket: PeerBytesTicket, facility: AddonPeerBytesFacility): Promise<Buffer> {
  const opened = await facility.peerBytes.open(ticket)
  if (opened.kind !== 'body') throw new Error(`expected a body, got ${opened.code}`)
  const chunks: Buffer[] = []
  for await (const chunk of opened.body.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks)
}

function ticketOf(
  result: Awaited<ReturnType<AddonPeerBytesFacility['peerBytes']['offer']>>,
): PeerBytesTicket {
  if (result.kind !== 'ticket') throw new Error(`expected a ticket, got ${result.code}`)
  return result.ticket
}

describe('the HOST a node id belongs to', () => {
  it('keeps the part before the runner suffix, because loopback is a fact about the HOST', () => {
    // A runner's node id is `<hostNode>/<runnerId>` (`addon-runner.ts`), and two
    // runners of the same hub CAN reach each other's loopback. Comparing the
    // full node id would refuse exactly the case this facility exists for.
    expect(hostNodeIdOf('hub/runner-3')).toBe('hub')
    expect(hostNodeIdOf('hub')).toBe('hub')
    expect(hostNodeIdOf('agent-a/runner-9')).toBe('agent-a')
  })
})

describe('a body is taken once', () => {
  it('serves the first GET and refuses a second by name', async () => {
    const { facility } = harness()
    const ticket = ticketOf(
      await facility.peerBytes.offerBuffer({
        bytes: Buffer.from('the whole clip'),
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      }),
    )
    expect((await drain(ticket, facility)).toString()).toBe('the whole clip')
    const second = await facility.peerBytes.open(ticket)
    expect(second.kind).toBe('refused')
    if (second.kind === 'refused') {
      expect(second.code).toBe('producer-refused')
      expect(second.detail).toContain('offer-used')
    }
    await facility.dispose()
  })

  it('lets a HEAD look without taking it', async () => {
    const { facility } = harness()
    const ticket = ticketOf(
      await facility.peerBytes.offerBuffer({
        bytes: Buffer.from('abcd'),
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      }),
    )
    const url = new URL(ticket.url)
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'HEAD' },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(200)
    // Still takeable: a HEAD is a look, not a take.
    expect((await drain(ticket, facility)).toString()).toBe('abcd')
    await facility.dispose()
  })
})

describe('nothing is lost to the opening tick', () => {
  it('delivers a body the producer wrote BEFORE the consumer attached a reader', async () => {
    // The D597 shape, reproduced deliberately: the whole body is already in
    // Node's hands when `open()` resolves, and the consumer then takes several
    // macrotasks to get ready. A response that was not paused would have
    // flushed `ftyp`/`moov` into the void on the next tick.
    const { facility } = harness()
    const body = Buffer.from('ftypmoovmdat-the-head-matters')
    const ticket = ticketOf(
      await facility.peerBytes.offerBuffer({
        bytes: body,
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      }),
    )
    const opened = await facility.peerBytes.open(ticket)
    expect(opened.kind).toBe('body')
    if (opened.kind !== 'body') return
    // Four turns of the loop with no reader attached at all.
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 5))
    const chunks: Buffer[] = []
    for await (const chunk of opened.body.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    expect(Buffer.concat(chunks).toString()).toBe(body.toString())
    await facility.dispose()
  })
})

describe('a ticket from another node is refused by NAME, not dialled', () => {
  it('names both nodes and never opens a socket', async () => {
    const { facility, warn } = harness({ nodeId: 'hub/runner-1' })
    const ticket = ticketOf(
      await facility.peerBytes.offerBuffer({
        bytes: Buffer.from('abcd'),
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      }),
    )
    // The same URL, claimed by a provider on the agent. Dialling it here would
    // reach whatever else holds that port on THIS host.
    const foreign: PeerBytesTicket = { ...ticket, hostNodeId: 'agent-a' }
    const opened = await facility.peerBytes.open(foreign)
    expect(opened.kind).toBe('refused')
    if (opened.kind === 'refused') {
      expect(opened.code).toBe('cross-node')
      expect(opened.detail).toContain('agent-a')
      expect(opened.detail).toContain('hub')
    }
    expect(warn.some((l) => l.message.includes('minted on another node'))).toBe(true)
    // And the offer is untouched — nothing was taken, so the real consumer on
    // the right host could still take it.
    expect(facility.peerBytes.outstanding).toBe(1)
    await facility.dispose()
  })
})

describe('a ticket has a life', () => {
  it('refuses an expired ticket without dialling', async () => {
    const { facility } = harness({ ttlMs: 20 })
    const ticket = ticketOf(
      await facility.peerBytes.offerBuffer({
        bytes: Buffer.from('abcd'),
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      }),
    )
    await new Promise((r) => setTimeout(r, 40))
    const opened = await facility.peerBytes.open(ticket)
    expect(opened.kind).toBe('refused')
    if (opened.kind === 'refused') expect(opened.code).toBe('ticket-expired')
    await facility.dispose()
  })

  it('bounds outstanding offers and refuses by name — which is also what stops this being a frame pipe', async () => {
    const { facility, warn } = harness({ maxOutstanding: 2 })
    const offer = async (): ReturnType<typeof facility.peerBytes.offerBuffer> =>
      await facility.peerBytes.offerBuffer({
        bytes: Buffer.from('abcd'),
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      })
    expect((await offer()).kind).toBe('ticket')
    expect((await offer()).kind).toBe('ticket')
    const third = await offer()
    expect(third.kind).toBe('refused')
    if (third.kind === 'refused') expect(third.code).toBe('offer-exhausted')
    expect(warn.some((l) => l.deviceId === 102 && l.message.includes('too many outstanding'))).toBe(
      true,
    )
    await facility.dispose()
  })
})

describe('the transfer is bounded, and a peer that never drains is cut', () => {
  it('aborts over maxBytes and leaves no partial file', async () => {
    const { facility } = harness()
    const dir = await mkdtemp(join(tmpdir(), 'peer-bytes-'))
    const out = join(dir, 'clip.mp4')
    const ticket = ticketOf(
      await facility.peerBytes.offerBuffer({
        bytes: Buffer.alloc(4 * 1024 * 1024, 7),
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      }),
    )
    const opened = await facility.peerBytes.open(ticket)
    expect(opened.kind).toBe('body')
    if (opened.kind !== 'body') return
    const written = await opened.body.writeToFile(out, { maxBytes: 64 * 1024 })
    expect(written.kind).toBe('refused')
    if (written.kind === 'refused') expect(written.code).toBe('too-large')
    // Half a video is worse than an honest refusal: nothing is left behind.
    await expect(stat(out)).rejects.toThrow()
    await facility.dispose()
  })

  it('writes the whole body through to disk when it fits', async () => {
    const { facility } = harness()
    const dir = await mkdtemp(join(tmpdir(), 'peer-bytes-'))
    const out = join(dir, 'clip.mp4')
    const body = Buffer.alloc(3 * 1024 * 1024, 9)
    const ticket = ticketOf(
      await facility.peerBytes.offerBuffer({
        bytes: body,
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      }),
    )
    const opened = await facility.peerBytes.open(ticket)
    if (opened.kind !== 'body') throw new Error('expected a body')
    expect(opened.body.declaredBytes).toBe(body.byteLength)
    const written = await opened.body.writeToFile(out, { maxBytes: 8 * 1024 * 1024 })
    expect(written).toEqual({ kind: 'written', bytes: body.byteLength })
    expect((await readFile(out)).equals(body)).toBe(true)
    await facility.dispose()
  })

  it('cuts a consumer that takes nothing, and says so per camera', async () => {
    // D447 from the producing side: a body held for a peer that is not reading
    // is heap in this process. The consumer here opens and never reads.
    const { facility, warn } = harness({ stallMs: 250 })
    const ticket = ticketOf(
      await facility.peerBytes.offerBuffer({
        bytes: Buffer.alloc(64 * 1024 * 1024, 3),
        contentType: 'video/mp4',
        label: 'test-clip',
        deviceId: 102,
      }),
    )
    const opened = await facility.peerBytes.open(ticket)
    expect(opened.kind).toBe('body')
    await new Promise((r) => setTimeout(r, 2_500))
    const cut = warn.find((l) => l.message.includes('cut before it was complete'))
    expect(cut).toBeDefined()
    expect(cut?.deviceId).toBe(102)
    expect(cut?.meta['branch']).toBe('stalled')
    if (opened.kind === 'body') opened.body.cancel('test over')
    await facility.dispose()
  })
})

describe('a file is offered, not read', () => {
  it('streams the producer’s own file and declares its size', async () => {
    const { facility } = harness()
    const dir = await mkdtemp(join(tmpdir(), 'peer-bytes-src-'))
    const src = join(dir, 'scratch.mp4')
    const body = Buffer.alloc(1024 * 512, 5)
    await (await import('node:fs/promises')).writeFile(src, body)
    const ticket = ticketOf(
      await facility.peerBytes.offerFile({
        path: src,
        contentType: 'video/mp4',
        label: 'hikvision-clip',
        deviceId: 3833,
      }),
    )
    expect(ticket.declaredBytes).toBe(body.byteLength)
    const got = await drain(ticket, facility)
    expect(got.equals(body)).toBe(true)
    await facility.dispose()
  })
})
