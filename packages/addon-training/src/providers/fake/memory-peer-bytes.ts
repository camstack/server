/**
 * An in-memory `ctx.peerBytes` for tests: offers hold a buffer under a token,
 * `open` hands it back once. Same one-shot rule as the real facility (a second
 * take is refused), so a test that dials a ticket twice fails like production.
 */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { PeerBytesHandlerResponse } from '@camstack/types'
import { Readable } from 'node:stream'
import type {
  PeerBytesOfferOptions,
  PeerBytesOfferResult,
  PeerBytesOpenResult,
  PeerBytesTicket,
} from '@camstack/types'

/** Just enough of a `ServerResponse` for a producer handler to write a body into memory. */
class CaptureResponse extends EventEmitter implements PeerBytesHandlerResponse {
  readonly chunks: Buffer[] = []
  readonly headersSent = false
  readonly writable = true
  readonly destroyed = false
  readonly writableEnded = false
  status = 0
  failed: Error | null = null
  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, string>,
    headers?: Record<string, string>,
  ): this {
    this.status = statusCode
    void statusMessageOrHeaders
    void headers
    return this
  }
  write(chunk: Uint8Array | string): boolean {
    this.chunks.push(Buffer.from(chunk))
    return true
  }
  end(cb?: () => void): this {
    this.emit('finish')
    cb?.()
    return this
  }
  destroy(err?: Error): this {
    this.failed = err ?? new Error('destroyed')
    return this
  }
  on(event: 'close' | 'drain' | 'data', listener: (...args: readonly unknown[]) => void): this {
    super.on(event, listener)
    return this
  }
  once(event: 'close' | 'drain', listener: () => void): this {
    super.once(event, listener)
    return this
  }
  off(event: 'close' | 'drain', listener: () => void): this {
    this.removeListener(event, listener)
    return this
  }
}

export class MemoryPeerBytes {
  private readonly offers = new Map<string, Buffer>()
  private n = 0

  offer(bytes: Buffer): PeerBytesTicket {
    this.n += 1
    const url = `http://127.0.0.1:1/mem-${String(this.n)}`
    this.offers.set(url, bytes)
    return {
      url,
      hostNodeId: 'hub',
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      declaredBytes: bytes.length,
    }
  }

  /**
   * `AddonPeerBytes.offer`, for a producer that streams through a handler:
   * the handler runs at once against an in-memory response and its body is
   * offered as a buffer. A handler that destroys its response is refused.
   */
  async offerHandler(options: PeerBytesOfferOptions): Promise<PeerBytesOfferResult> {
    const res = new CaptureResponse()
    const req = new EventEmitter()
    // A documented test boundary: the handler only ever calls the methods CaptureResponse has.
    await options.handler(req as IncomingMessage, res)
    if (res.failed !== null)
      return { kind: 'refused', code: 'listener-failed', detail: res.failed.message }
    return { kind: 'ticket', ticket: this.offer(Buffer.concat(res.chunks)) }
  }

  /** Bytes still waiting to be taken. */
  get outstanding(): number {
    return this.offers.size
  }

  async open(ticket: PeerBytesTicket): Promise<PeerBytesOpenResult> {
    const bytes = this.offers.get(ticket.url)
    if (bytes === undefined) {
      return { kind: 'refused', code: 'producer-refused', detail: 'dial-used', status: 410 }
    }
    this.offers.delete(ticket.url)
    return {
      kind: 'body',
      body: {
        status: 200,
        contentType: 'application/octet-stream',
        declaredBytes: bytes.length,
        stream: Readable.from([bytes]),
        writeToFile: async (target, { maxBytes }) => {
          if (bytes.length > maxBytes) {
            return {
              kind: 'refused',
              code: 'too-large',
              detail: `${String(bytes.length)} > ${String(maxBytes)}`,
              bytes: maxBytes,
            }
          }
          await writeFile(target, bytes)
          return { kind: 'written', bytes: bytes.length }
        },
        cancel: () => undefined,
      },
    }
  }

  /** Take a ticket whole into memory (what a provider does with an upload). */
  async take(ticket: PeerBytesTicket): Promise<{ bytes: Buffer; sha256: string }> {
    const opened = await this.open(ticket)
    if (opened.kind === 'refused') throw new Error(`peer bytes refused: ${opened.code}`)
    const chunks: Buffer[] = []
    for await (const chunk of opened.body.stream) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
}
