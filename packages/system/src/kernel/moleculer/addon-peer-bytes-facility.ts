/**
 * Kernel side of the addon→addon **byte transport** (`ctx.peerBytes`, D613).
 *
 * See {@link AddonPeerBytes} for what this exists for and what it deliberately
 * does not do. This file is the mechanism:
 *
 * - **One lazy loopback listener per addon process.** Bound on the first
 *   `offer()`, never before, so an addon that never offers pays no port.
 * - **One token per offer.** 24 random bytes, base64url, ONE `GET`. A replay
 *   is `offer-used` (410) for as long as the original ticket would have lived,
 *   so a second take is told what happened rather than "no such thing".
 *   `HEAD` answers the headers and consumes nothing.
 * - **Outstanding offers are bounded and swept on every mint**, which is also
 *   what makes a per-frame misuse of this facility refuse by name instead of
 *   working slowly.
 * - **Every write honours `write()`'s return and awaits `drain`** (D447), and
 *   a peer that has taken nothing for {@link PEER_BYTES_STALL_MS} is cut. Every
 *   exit — offered, taken, sent, cut, stalled, refused, disposed — is one log
 *   line, carrying `tags: { deviceId }` when the offer named a device.
 * - **The consumer's response is handed over PAUSED**, which is the whole
 *   reason `open()` lives in the framework rather than in each consumer: see
 *   {@link PeerBytesBody}.
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { request as httpRequest, createServer, type IncomingMessage } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { once } from 'node:events'
import type { Readable } from 'node:stream'

import {
  PEER_BYTES_CHUNK_BYTES,
  PEER_BYTES_MAX_OUTSTANDING,
  PEER_BYTES_STALL_MS,
  PEER_BYTES_TICKET_TTL_MS,
  type AddonPeerBytes,
  type PeerBytesBody,
  type PeerBytesBufferOffer,
  type PeerBytesFileOffer,
  type PeerBytesHandler,
  type PeerBytesHandlerResponse,
  type PeerBytesOfferOptions,
  type PeerBytesOfferResult,
  type PeerBytesOpenResult,
  type PeerBytesTicket,
  type PeerBytesWriteOptions,
  type PeerBytesWriteResult,
} from '@camstack/types/addon'
// Types are free at runtime — only the VALUE import had to move off the
// barrel (D28); this one stays where every sibling takes it.
import type { IScopedLogger } from '@camstack/types'

export interface AddonPeerBytesFacility {
  readonly peerBytes: AddonPeerBytes
  dispose(): Promise<void>
}

export interface AddonPeerBytesFacilityArgs {
  readonly addonId: string
  readonly logger: IScopedLogger
  /**
   * This process's node id. A runner's is `<hostNode>/<runnerId>`
   * (`addon-runner.ts`), so the HOST — the only thing loopback reachability is
   * a fact about — is the part before the first slash.
   */
  readonly nodeId: string
  /** Loopback, and only loopback, in production. */
  readonly host?: string
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxOutstanding?: number
  readonly stallMs?: number
}

/** The HOST a node id belongs to. `hub` → `hub`; `hub/runner-3` → `hub`. */
export function hostNodeIdOf(nodeId: string): string {
  const slash = nodeId.indexOf('/')
  return slash === -1 ? nodeId : nodeId.slice(0, slash)
}

interface MintedOffer {
  readonly handler: PeerBytesHandler
  readonly label: string
  readonly deviceId: number | undefined
  readonly expiresAtMs: number
}

/** A body chunk, without a cast. A readable in binary mode yields Buffers; in
 *  string mode, strings. Anything else is a broken stream and says so. */
function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk)
  throw new Error('peer-bytes: a body chunk was neither a Buffer nor a string')
}

function tokenOf(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const query = raw.indexOf('?')
  const path = query === -1 ? raw : raw.slice(0, query)
  return path.replace(/^\/+/, '')
}

/**
 * Write `bytes` to `res` in bounded chunks, honouring backpressure.
 *
 * D447, the consuming half stated from the producing side: a raw HTTP stream
 * writes no chunk the socket has not taken. `write()` returning false means the
 * kernel buffer is full and everything further is heap in THIS process — so we
 * wait for `drain`, and a peer that never drains within `stallMs` is cut rather
 * than held. Returns how many bytes reached the socket and why it stopped.
 */
async function writeBufferWithBackpressure(
  res: PeerBytesHandlerResponse,
  bytes: Buffer,
  stallMs: number,
): Promise<{ readonly sent: number; readonly outcome: 'sent' | 'stalled' | 'peer-gone' }> {
  // Listeners are attached and removed per wait, never accumulated. A
  // `Promise.race` of two `events.once(...)` leaves the loser's listener on
  // the response, and a multi-megabyte body drains many times — which is a
  // warning today and an actual leak on a long transfer.
  const waitForDrain = (): Promise<'drained' | 'stalled' | 'closed'> =>
    new Promise((resolve) => {
      const settle = (outcome: 'drained' | 'stalled' | 'closed'): void => {
        clearTimeout(timer)
        res.off('drain', onDrain)
        res.off('close', onClose)
        resolve(outcome)
      }
      const onDrain = (): void => {
        settle('drained')
      }
      const onClose = (): void => {
        settle('closed')
      }
      const timer = setTimeout(() => {
        settle('stalled')
      }, stallMs)
      timer.unref()
      res.on('drain', onDrain)
      res.on('close', onClose)
    })

  let sent = 0
  while (sent < bytes.byteLength) {
    if (res.destroyed || res.writableEnded) return { sent, outcome: 'peer-gone' }
    const end = Math.min(sent + PEER_BYTES_CHUNK_BYTES, bytes.byteLength)
    const took = res.write(bytes.subarray(sent, end))
    sent = end
    if (took) continue
    const waited = await waitForDrain()
    if (waited === 'drained') continue
    return { sent, outcome: waited === 'closed' ? 'peer-gone' : 'stalled' }
  }
  return { sent, outcome: 'sent' }
}

export function createAddonPeerBytesFacility(
  args: AddonPeerBytesFacilityArgs,
): AddonPeerBytesFacility {
  const now = args.now ?? ((): number => Date.now())
  const ttlMs = args.ttlMs ?? PEER_BYTES_TICKET_TTL_MS
  const maxOutstanding = args.maxOutstanding ?? PEER_BYTES_MAX_OUTSTANDING
  const stallMs = args.stallMs ?? PEER_BYTES_STALL_MS
  const host = args.host ?? '127.0.0.1'
  const hostNodeId = hostNodeIdOf(args.nodeId)

  const offers = new Map<string, MintedOffer>()
  /** Tokens already taken, kept for their TTL so a replay is `offer-used`. */
  const taken = new Map<string, number>()
  let server: Server | null = null
  let baseUrl: string | null = null
  let listening: Promise<string> | null = null

  const sweep = (): void => {
    const at = now()
    for (const [token, offer] of offers) {
      if (offer.expiresAtMs <= at) {
        offers.delete(token)
        args.logger.info('peer-bytes: an offer expired untaken', {
          ...(offer.deviceId !== undefined ? { tags: { deviceId: offer.deviceId } } : {}),
          meta: { label: offer.label, outstanding: offers.size },
        })
      }
    }
    for (const [token, expiresAtMs] of taken) if (expiresAtMs <= at) taken.delete(token)
  }

  const route = (req: IncomingMessage, res: ServerResponse): void => {
    const token = tokenOf(req)
    const offer = offers.get(token)
    if (offer === undefined) {
      const status = taken.has(token) ? 410 : 404
      res.writeHead(status, { 'x-camstack-peer-bytes': status === 410 ? 'offer-used' : 'no-offer' })
      res.end()
      return
    }
    if (offer.expiresAtMs <= now()) {
      offers.delete(token)
      res.writeHead(410, { 'x-camstack-peer-bytes': 'offer-expired' }).end()
      return
    }
    if (req.method === 'GET') {
      // One shot: the first GET takes it. A HEAD looks and leaves it.
      offers.delete(token)
      taken.set(token, offer.expiresAtMs)
      args.logger.info('peer-bytes: an offer was taken', {
        ...(offer.deviceId !== undefined ? { tags: { deviceId: offer.deviceId } } : {}),
        meta: { label: offer.label, outstanding: offers.size },
      })
    }
    Promise.resolve(offer.handler(req, res)).catch((err: unknown) => {
      args.logger.warn('peer-bytes: an offer handler threw', {
        ...(offer.deviceId !== undefined ? { tags: { deviceId: offer.deviceId } } : {}),
        meta: { label: offer.label, error: err instanceof Error ? err.message : String(err) },
      })
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  }

  const listen = (): Promise<string> => {
    if (listening !== null) return listening
    listening = new Promise<string>((resolve, reject) => {
      const created = createServer((req, res) => {
        route(req, res)
      })
      created.on('error', (err: Error) => {
        listening = null
        reject(err)
      })
      created.listen(0, host, () => {
        const address: AddressInfo | string | null = created.address()
        if (address === null || typeof address === 'string') {
          created.close()
          listening = null
          reject(new Error('the peer-bytes listener bound no TCP port'))
          return
        }
        server = created
        baseUrl = `http://${host}:${address.port}`
        args.logger.info('peer-bytes: listener bound', {
          meta: { addonId: args.addonId, host, port: address.port, hostNodeId, ttlMs },
        })
        resolve(baseUrl)
      })
    })
    return listening
  }

  const mint = async (options: PeerBytesOfferOptions): Promise<PeerBytesOfferResult> => {
    sweep()
    const deviceTags =
      options.deviceId !== undefined ? { tags: { deviceId: options.deviceId } } : {}
    if (offers.size >= maxOutstanding) {
      args.logger.warn('peer-bytes: offer refused — too many outstanding', {
        ...deviceTags,
        meta: { label: options.label, outstanding: offers.size, maxOutstanding },
      })
      return {
        kind: 'refused',
        code: 'offer-exhausted',
        detail: `${String(offers.size)} offers outstanding against a bound of ${String(maxOutstanding)}`,
      }
    }
    let base: string
    try {
      base = baseUrl ?? (await listen())
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      args.logger.warn('peer-bytes: offer refused — no listener', {
        ...deviceTags,
        meta: { label: options.label, error: detail },
      })
      return { kind: 'refused', code: 'listener-failed', detail }
    }
    const token = randomBytes(24).toString('base64url')
    const expiresAtMs = now() + (options.ttlMs ?? ttlMs)
    offers.set(token, {
      handler: options.handler,
      label: options.label,
      deviceId: options.deviceId,
      expiresAtMs,
    })
    args.logger.info('peer-bytes: offer minted', {
      ...deviceTags,
      meta: {
        label: options.label,
        declaredBytes: options.declaredBytes ?? null,
        expiresInMs: expiresAtMs - now(),
        outstanding: offers.size,
      },
    })
    return {
      kind: 'ticket',
      ticket: {
        url: `${base}/${token}`,
        hostNodeId,
        expiresAtMs,
        declaredBytes: options.declaredBytes ?? null,
      },
    }
  }

  const peerBytes: AddonPeerBytes = {
    hostNodeId,
    get outstanding(): number {
      sweep()
      return offers.size
    },

    offer: mint,

    offerBuffer: async (options: PeerBytesBufferOffer): Promise<PeerBytesOfferResult> => {
      const deviceTags =
        options.deviceId !== undefined ? { tags: { deviceId: options.deviceId } } : {}
      const handler: PeerBytesHandler = async (req, res) => {
        res.writeHead(200, {
          'content-type': options.contentType,
          'content-length': String(options.bytes.byteLength),
          'accept-ranges': 'none',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        const startedAt = now()
        const result = await writeBufferWithBackpressure(res, options.bytes, stallMs)
        if (result.outcome === 'sent') {
          res.end()
          args.logger.info('peer-bytes: body sent', {
            ...deviceTags,
            meta: {
              label: options.label,
              bytes: result.sent,
              tookMs: now() - startedAt,
              source: 'buffer',
            },
          })
          return
        }
        // A branch that accepts work and produces nothing says so (D391).
        args.logger.warn('peer-bytes: body cut before it was complete', {
          ...deviceTags,
          meta: {
            label: options.label,
            branch: result.outcome,
            sent: result.sent,
            of: options.bytes.byteLength,
            stallMs,
            source: 'buffer',
          },
        })
        res.destroy()
      }
      return await mint({
        handler,
        label: options.label,
        declaredBytes: options.bytes.byteLength,
        ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      })
    },

    offerFile: async (options: PeerBytesFileOffer): Promise<PeerBytesOfferResult> => {
      const deviceTags =
        options.deviceId !== undefined ? { tags: { deviceId: options.deviceId } } : {}
      let declaredBytes: number | null = null
      try {
        declaredBytes = (await stat(options.path)).size
      } catch {
        // The offer is still minted: the take will fail and say so, with a
        // status the consumer can read, rather than the mint refusing for a
        // file that may appear in the next millisecond. `null` is "unknown",
        // never 0 (D393).
        declaredBytes = null
      }
      const handler: PeerBytesHandler = async (req, res) => {
        const headers: Record<string, string> = {
          'content-type': options.contentType,
          'accept-ranges': 'none',
        }
        if (declaredBytes !== null) headers['content-length'] = String(declaredBytes)
        if (req.method === 'HEAD') {
          res.writeHead(200, headers).end()
          return
        }
        const startedAt = now()
        let stream: ReadStream
        try {
          stream = createReadStream(options.path)
          await once(stream, 'open')
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err)
          args.logger.warn('peer-bytes: the offered file could not be opened', {
            ...deviceTags,
            meta: { label: options.label, error: detail },
          })
          if (!res.headersSent) res.writeHead(503, { 'x-camstack-peer-bytes': 'file-unreadable' })
          res.end()
          return
        }
        res.writeHead(200, headers)
        // `pipe` honours `write()`'s return natively; the stall timer is what
        // decides a peer that has taken nothing at all.
        let sent = 0
        let lastProgressAt = now()
        // `pipe` FIRST, and the counter after it, both synchronously. Attaching
        // a `data` listener puts the stream in flowing mode from the next tick,
        // so a counter attached in a LATER tick than the pipe would be counting
        // a stream that had already started — and one attached before a pipe
        // that landed in a later tick would have lost the head, which is the
        // shape of the bug this whole facility is built around (D597).
        stream.pipe(res as ServerResponse)
        stream.on('data', (chunk: string | Buffer) => {
          sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
          lastProgressAt = now()
        })
        const stallTimer = setInterval(
          () => {
            if (now() - lastProgressAt < stallMs) return
            clearInterval(stallTimer)
            args.logger.warn('peer-bytes: body cut before it was complete', {
              ...deviceTags,
              meta: { label: options.label, branch: 'stalled', sent, stallMs, source: 'file' },
            })
            stream.destroy()
            res.destroy()
          },
          Math.max(1_000, Math.floor(stallMs / 4)),
        )
        stallTimer.unref()
        const ended = await Promise.race([
          once(stream, 'end').then(() => true),
          new Promise<boolean>((resolve) => {
            res.once('close', () => {
              resolve(false)
            })
          }),
        ]).catch(() => false)
        clearInterval(stallTimer)
        if (ended) {
          args.logger.info('peer-bytes: body sent', {
            ...deviceTags,
            meta: {
              label: options.label,
              bytes: sent,
              tookMs: now() - startedAt,
              source: 'file',
            },
          })
          return
        }
        stream.destroy()
        args.logger.warn('peer-bytes: body cut before it was complete', {
          ...deviceTags,
          meta: {
            label: options.label,
            branch: 'peer-gone',
            sent,
            of: declaredBytes,
            source: 'file',
          },
        })
      }
      return await mint({
        handler,
        label: options.label,
        ...(declaredBytes !== null ? { declaredBytes } : {}),
        ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      })
    },

    open: async (ticket: PeerBytesTicket): Promise<PeerBytesOpenResult> => {
      if (ticket.hostNodeId !== hostNodeId) {
        // Loopback does not cross a node boundary, and dialling anyway would
        // reach whatever else holds that port on THIS host. Refused by name,
        // never attempted. Device providers run on agents, so this is real.
        args.logger.warn('peer-bytes: refusing a ticket minted on another node', {
          meta: { mintedOn: ticket.hostNodeId, here: hostNodeId },
        })
        return {
          kind: 'refused',
          code: 'cross-node',
          detail:
            `this ticket was minted on node "${ticket.hostNodeId}" and this process runs on ` +
            `"${hostNodeId}" — peer-bytes is loopback only, so there is nothing to dial`,
        }
      }
      if (ticket.expiresAtMs <= now()) {
        return {
          kind: 'refused',
          code: 'ticket-expired',
          detail: `this ticket expired ${String(now() - ticket.expiresAtMs)} ms ago`,
        }
      }
      let url: URL
      try {
        url = new URL(ticket.url)
      } catch {
        return { kind: 'refused', code: 'ticket-malformed', detail: `"${ticket.url}" is not a URL` }
      }
      if (url.protocol !== 'http:') {
        return {
          kind: 'refused',
          code: 'ticket-malformed',
          detail: `peer-bytes dials http, not "${url.protocol}"`,
        }
      }

      const req = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
      })
      let response: IncomingMessage
      try {
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          req.once('response', resolve)
          req.once('error', reject)
          req.end()
        })
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err)
        req.destroy()
        args.logger.warn('peer-bytes: the dial failed', { meta: { error: detail } })
        return { kind: 'refused', code: 'unreachable', detail }
      }
      // PAUSE BEFORE ANYTHING ELSE. Node flushes what it already holds on the
      // next tick once a `data` listener attaches, and that tick runs before
      // the caller's own continuation — which is how the head of every clip
      // stream (`ftyp`, `moov`) was thrown away with fourteen green tests
      // (D597). Nothing flows until the consumer reads.
      response.pause()

      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        const reason = response.headers['x-camstack-peer-bytes']
        response.resume()
        req.destroy()
        return {
          kind: 'refused',
          code: 'producer-refused',
          detail:
            typeof reason === 'string'
              ? `the producer answered ${String(status)} (${reason})`
              : `the producer answered ${String(status)}`,
          status,
        }
      }
      const lengthHeader = response.headers['content-length']
      const declaredBytes =
        typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null
      const contentTypeHeader = response.headers['content-type']
      const stream: Readable = response

      const body: PeerBytesBody = {
        status,
        contentType: typeof contentTypeHeader === 'string' ? contentTypeHeader : null,
        declaredBytes,
        stream,
        cancel: (reason: string): void => {
          args.logger.info('peer-bytes: the consumer gave up on a body', { meta: { reason } })
          response.destroy()
          req.destroy()
        },
        writeToFile: async (
          path: string,
          options: PeerBytesWriteOptions,
        ): Promise<PeerBytesWriteResult> => {
          await mkdir(dirname(path), { recursive: true })
          const sink = createWriteStream(path)
          // `createWriteStream` opens its fd ASYNCHRONOUSLY. Removing the file
          // while that open is still in flight lets the open re-create it
          // afterwards, and the partial file this branch exists to delete
          // survives — intermittently, which is worse than always.
          const discard = async (): Promise<void> => {
            sink.destroy()
            if (!sink.closed) {
              await once(sink, 'close').catch(() => undefined)
            }
            await rm(path, { force: true })
          }
          let written = 0
          let overrun = false
          try {
            for await (const chunk of stream) {
              const buf = asBuffer(chunk)
              written += buf.byteLength
              if (written > options.maxBytes) {
                overrun = true
                break
              }
              if (!sink.write(buf)) await once(sink, 'drain')
            }
          } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : String(err)
            response.destroy()
            req.destroy()
            await discard()
            return { kind: 'refused', code: 'transfer-failed', detail, bytes: written }
          }
          if (overrun) {
            // Half a video is worse than an honest refusal (D558). Aborted,
            // and the partial file removed — never truncated and kept.
            response.destroy()
            req.destroy()
            await discard()
            return {
              kind: 'refused',
              code: 'too-large',
              detail: `the body passed ${String(options.maxBytes)} bytes and was aborted`,
              bytes: written,
            }
          }
          try {
            sink.end()
            await once(sink, 'close')
          } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : String(err)
            await discard()
            return { kind: 'refused', code: 'write-failed', detail, bytes: written }
          }
          return { kind: 'written', bytes: written }
        },
      }
      return { kind: 'body', body }
    },
  }

  const dispose = async (): Promise<void> => {
    offers.clear()
    taken.clear()
    const open = server
    server = null
    baseUrl = null
    listening = null
    if (open === null) return
    await new Promise<void>((resolve) => {
      open.close(() => resolve())
      open.closeAllConnections()
    })
    args.logger.info('peer-bytes: listener closed', { meta: { addonId: args.addonId } })
  }

  return { peerBytes, dispose }
}
