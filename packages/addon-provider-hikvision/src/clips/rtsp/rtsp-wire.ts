/**
 * The RTSP-over-TCP wire, as a pure incremental reader.
 *
 * One socket carries two kinds of thing, interleaved with no framing between
 * them: RTSP text responses, and RTP packets wrapped in the 4-byte `$`
 * envelope of RFC 2326 §10.12. This module turns an arbitrary chunk stream
 * into that sequence of events and holds a partial of either across chunks —
 * the whole reason it is a state machine and not a `split()`.
 *
 * Pure: no socket, no timers, no logger. Everything a live session does to it
 * can be done to it from a file, which is how it is tested — the bytes of a
 * real replay, fed one at a time and in blocks, must produce exactly what they
 * produce when fed whole.
 *
 * ## Why a bound on the text head
 *
 * A camera that answers a malformed response, or a socket that resyncs on
 * noise, would otherwise make this buffer grow for ever waiting for a
 * `\r\n\r\n` that is never coming. The reader refuses past
 * {@link RTSP_MAX_HEAD_BYTES} and says so, which the session turns into a cut
 * rather than a leak.
 */

/** Largest RTSP response head (status line + headers) this reader will hold. */
export const RTSP_MAX_HEAD_BYTES = 16 * 1024

export interface RtspResponse {
  readonly kind: 'response'
  readonly status: number
  /** Header names lower-cased; values verbatim. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface RtspInterleaved {
  readonly kind: 'interleaved'
  readonly channel: number
  /** The RTP (or RTCP) packet, without the 4-byte envelope. */
  readonly payload: Buffer
}

export interface RtspMalformed {
  readonly kind: 'malformed'
  readonly reason: string
}

export type RtspWireEvent = RtspResponse | RtspInterleaved | RtspMalformed

export interface RtspWireReader {
  /** Feed bytes; get every complete event they closed, in order. */
  push(chunk: Buffer): readonly RtspWireEvent[]
  /** Bytes held back waiting for the rest of their event. */
  pending(): number
}

function parseHead(head: string): { status: number; headers: Record<string, string> } | null {
  const lines = head.split('\r\n')
  const statusLine = lines[0] ?? ''
  if (!statusLine.startsWith('RTSP/')) return null
  const status = Number(statusLine.split(' ')[1])
  if (!Number.isInteger(status)) return null
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers[line.slice(0, colon).toLowerCase().trim()] = line.slice(colon + 1).trim()
  }
  return { status, headers }
}

export function createRtspWireReader(): RtspWireReader {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let poisoned = false

  return {
    pending: () => buffer.byteLength,
    push(chunk) {
      if (poisoned) return []
      buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk])
      const events: RtspWireEvent[] = []
      for (;;) {
        if (buffer.byteLength === 0) return events

        if (buffer[0] === 0x24) {
          if (buffer.byteLength < 4) return events
          const length = buffer.readUInt16BE(2)
          if (buffer.byteLength < 4 + length) return events
          events.push({
            kind: 'interleaved',
            channel: buffer[1] ?? 0,
            // A copy: the caller keeps packets across chunks and the source
            // buffer is re-sliced under it on the very next push.
            payload: Buffer.from(buffer.subarray(4, 4 + length)),
          })
          buffer = buffer.subarray(4 + length)
          continue
        }

        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) {
          if (buffer.byteLength > RTSP_MAX_HEAD_BYTES) {
            poisoned = true
            events.push({
              kind: 'malformed',
              reason: `no RTSP head in ${String(buffer.byteLength)} bytes`,
            })
            buffer = Buffer.alloc(0)
          }
          return events
        }
        const head = buffer.subarray(0, end).toString('latin1')
        const parsed = parseHead(head)
        if (parsed === null) {
          poisoned = true
          events.push({ kind: 'malformed', reason: `not an RTSP response: ${head.slice(0, 80)}` })
          buffer = Buffer.alloc(0)
          return events
        }
        const declared = Number(parsed.headers['content-length'] ?? '0')
        const bodyLength = Number.isInteger(declared) && declared > 0 ? declared : 0
        if (buffer.byteLength < end + 4 + bodyLength) return events
        events.push({
          kind: 'response',
          status: parsed.status,
          headers: parsed.headers,
          body: buffer.subarray(end + 4, end + 4 + bodyLength).toString('utf8'),
        })
        buffer = buffer.subarray(end + 4 + bodyLength)
      }
    },
  }
}

export interface RtspRequest {
  readonly method: string
  readonly url: string
  readonly cseq: number
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Serialise a request.
 *
 * `latin1`, because the only thing that ever travels here is the digest header
 * and a URL, and a multi-byte encoding would put a `Content-Length` on the
 * wire that disagrees with the bytes.
 */
export function encodeRtspRequest(request: RtspRequest): Buffer {
  const lines = [
    `${request.method} ${request.url} RTSP/1.0`,
    `CSeq: ${String(request.cseq)}`,
    ...Object.entries(request.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
  ]
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1')
}
