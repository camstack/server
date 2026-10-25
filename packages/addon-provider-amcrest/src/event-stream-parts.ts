import type { AmcrestEvent, AmcrestEventHandlers } from './amcrest-cgi-client.js'

/**
 * Reading the Dahua `eventManager.cgi?action=attach` multipart stream.
 *
 * A part is delivered the moment it is COMPLETE — its headers plus
 * `Content-Length` bytes of body — never when the next part's boundary
 * arrives (D669). The camera sends one part per edge and then says nothing
 * until the next edge, so a reader that waits for the following boundary is
 * exactly one event behind: it reported every `Start` at the firmware's `Stop`
 * and every `Stop` at the next `Start`, and CamStack recorded the quiet
 * between episodes instead of the episodes.
 *
 * A part with no `Content-Length` header has no other end than the next
 * boundary, so that — and only that — part still waits for it.
 */

/** One unit the reader carved out of the buffered bytes. */
export type MultipartItem =
  /** A complete part: its body, headers stripped. */
  | { readonly kind: 'part'; readonly body: Uint8Array }
  /** Bytes between two parts that belong to neither — named, never skipped in silence. */
  | { readonly kind: 'junk'; readonly bytes: Uint8Array }

export interface MultipartRead {
  readonly items: readonly MultipartItem[]
  /** Bytes of a part that is not complete yet — carried into the next read. */
  readonly rest: Uint8Array
  /** True once the first boundary of the stream has been seen. */
  readonly preambleConsumed: boolean
}

/** The minimal surface the pump needs from the HTTP response. */
export interface EventByteSource extends AsyncIterable<unknown> {
  destroy(): void
}

type PartAt =
  | { readonly kind: 'part'; readonly body: Uint8Array; readonly next: number }
  | { readonly kind: 'close'; readonly next: number }

const CRLF_CRLF = Buffer.from('\r\n\r\n', 'latin1')
const LF_LF = Buffer.from('\n\n', 'latin1')
const CLOSE_SUFFIX = '--'
const CONTENT_LENGTH_RE = /^content-length\s*:\s*(\d+)\s*$/im
const HEARTBEAT_RE = /^(?:code=)?heartbeat(?:;|$)/i

/**
 * Carve every complete part out of `input`.
 *
 * `preambleConsumed` is per STREAM, not per call: RFC 1521's preamble is the
 * bytes before the first boundary, once. Discarding a leading fragment on every
 * call threw away every part on 2026-09-04 (see the pump test).
 */
export function readCompleteParts(
  input: Uint8Array,
  dashBoundary: string,
  preambleConsumed: boolean,
): MultipartRead {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const marker = Buffer.from(dashBoundary, 'latin1')
  const items: MultipartItem[] = []
  let pos = 0
  if (!preambleConsumed) {
    const first = buf.indexOf(marker)
    if (first < 0) return { items, rest: input, preambleConsumed: false }
    pos = first
  }
  for (;;) {
    pos = skipLineBreaks(buf, pos)
    const boundaryAt = buf.indexOf(marker, pos)
    // No boundary in what is left: either a boundary still in flight or the
    // start of junk the next boundary will close. Both wait.
    if (boundaryAt < 0) break
    if (boundaryAt > pos) {
      items.push({ kind: 'junk', bytes: Buffer.from(buf.subarray(pos, boundaryAt)) })
      pos = boundaryAt
    }
    const part = readPartAt(buf, pos, marker)
    if (part === null) break
    if (part.kind === 'part') items.push({ kind: 'part', body: part.body })
    pos = part.next
  }
  return { items, rest: Buffer.from(buf.subarray(pos)), preambleConsumed: true }
}

/** Read the part whose boundary starts at `at`, or null when it is not complete yet. */
function readPartAt(buf: Buffer, at: number, marker: Buffer): PartAt | null {
  const afterMarker = at + marker.length
  if (buf.length < afterMarker + CLOSE_SUFFIX.length) return null
  if (buf.toString('latin1', afterMarker, afterMarker + CLOSE_SUFFIX.length) === CLOSE_SUFFIX) {
    return { kind: 'close', next: afterMarker + CLOSE_SUFFIX.length }
  }
  const nextMarker = buf.indexOf(marker, afterMarker)
  const terminator = findHeaderTerminator(buf, afterMarker)
  const headerEnd = terminator?.at ?? -1
  const headersComplete = headerEnd >= 0 && (nextMarker < 0 || headerEnd < nextMarker)
  if (!headersComplete) {
    // A part with no header terminator ends only at the next boundary; the
    // whole block is its body (a headerless keep-alive frame).
    if (nextMarker < 0) return null
    return {
      kind: 'part',
      body: Buffer.from(buf.subarray(afterMarker, nextMarker)),
      next: nextMarker,
    }
  }
  const bodyStart = headerEnd + (terminator?.length ?? 0)
  const contentLength = parseContentLength(buf.toString('latin1', afterMarker, headerEnd))
  if (contentLength === null) {
    if (nextMarker < 0) return null
    return {
      kind: 'part',
      body: Buffer.from(buf.subarray(bodyStart, nextMarker)),
      next: nextMarker,
    }
  }
  const bodyEnd = bodyStart + contentLength
  // A length that runs past the next boundary overstates the body: the
  // boundary is the truth, the part ends there.
  if (nextMarker >= 0 && nextMarker < bodyEnd) {
    return {
      kind: 'part',
      body: Buffer.from(buf.subarray(bodyStart, nextMarker)),
      next: nextMarker,
    }
  }
  if (buf.length < bodyEnd) return null
  return { kind: 'part', body: Buffer.from(buf.subarray(bodyStart, bodyEnd)), next: bodyEnd }
}

interface HeaderTerminator {
  readonly at: number
  readonly length: number
}

/**
 * The blank line that ends a part's headers: CRLFCRLF by the spec, bare LFLF
 * from a firmware that writes Unix line ends. Accepting only CRLF would drop a
 * bare-LF part into the no-header branch, which waits for the next boundary —
 * the very lag D669 removes, back in silence.
 */
function findHeaderTerminator(buf: Buffer, from: number): HeaderTerminator | null {
  const crlf = buf.indexOf(CRLF_CRLF, from)
  const lf = buf.indexOf(LF_LF, from)
  if (crlf < 0 && lf < 0) return null
  if (lf < 0 || (crlf >= 0 && crlf < lf)) return { at: crlf, length: CRLF_CRLF.length }
  return { at: lf, length: LF_LF.length }
}

function parseContentLength(headers: string): number | null {
  const m = CONTENT_LENGTH_RE.exec(headers)
  if (!m) return null
  const n = Number.parseInt(m[1]!, 10)
  return Number.isSafeInteger(n) ? n : null
}

function skipLineBreaks(buf: Buffer, from: number): number {
  let i = from
  while (i < buf.length && (buf[i] === 0x0d || buf[i] === 0x0a)) i++
  return i
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

/**
 * A `heartbeat=N` keep-alive part: the bare body `Heartbeat` (or, on some
 * firmwares, `Code=Heartbeat`). It proves the stream is alive and is never an
 * event.
 */
function isHeartbeat(bodyText: string): boolean {
  return HEARTBEAT_RE.test(bodyText)
}

type Delivery =
  | { readonly kind: 'event'; readonly event: AmcrestEvent }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'unparsed'; readonly reason: 'block' | 'body'; readonly preview: string }

function classify(item: MultipartItem, observedAt: number): Delivery {
  if (item.kind === 'junk') {
    return {
      kind: 'unparsed',
      reason: 'block',
      preview: Buffer.from(item.bytes).toString('utf8').slice(0, 160),
    }
  }
  const bodyText = Buffer.from(item.body).toString('utf8').trim()
  if (isHeartbeat(bodyText)) return { kind: 'heartbeat' }
  const event = parseAmcrestEventBody(bodyText, observedAt)
  if (event === null) return { kind: 'unparsed', reason: 'body', preview: bodyText.slice(0, 160) }
  return { kind: 'event', event }
}

/**
 * Hard cap on the bytes carried between chunks while a part is incomplete —
 * the same bound, and the same resync, as the Hikvision alarm stream
 * (`ALARM_STREAM_MAX_BUFFER_BYTES`). A real part is ~100 bytes. Past this we
 * are not parsing the stream at all: a first boundary that never came, or a
 * `Content-Length` no boundary ever cuts short. The attach GET has no timeout
 * by design, so without the cap that buffer grows for the life of the
 * connection with no line saying so.
 */
export const EVENT_STREAM_MAX_BUFFER_BYTES = 1_048_576

/** Bytes kept from the END of the buffer when the cap trips — enough to hold a
 *  whole part plus the boundary that frames it. */
export const EVENT_STREAM_BUFFER_RETAIN_BYTES = 65_536

/**
 * Pump the attach stream: every chunk is appended to the carry buffer and
 * every part it completes is delivered before the next chunk is awaited.
 *
 * `onBytes` names every chunk except one that carried nothing but complete
 * heartbeats — at `heartbeat=5` those would be twelve lines a minute of
 * nothing, and the stream's liveness is not what that line is for.
 */
export async function pumpEventStream(
  stream: EventByteSource,
  boundary: string,
  handlers: AmcrestEventHandlers,
): Promise<void> {
  const dashBoundary = `--${boundary}`
  let buffered: Uint8Array = new Uint8Array(0)
  let preambleConsumed = false
  try {
    for await (const chunk of stream) {
      const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(0)
      if (value.byteLength === 0) continue
      const observedAt = Date.now()
      const read = readCompleteParts(concatBytes(buffered, value), dashBoundary, preambleConsumed)
      buffered = read.rest
      preambleConsumed = read.preambleConsumed
      if (buffered.byteLength > EVENT_STREAM_MAX_BUFFER_BYTES) {
        handlers.onBufferOverflow?.(
          buffered.byteLength - EVENT_STREAM_BUFFER_RETAIN_BYTES,
          new TextDecoder().decode(buffered.slice(0, 120)),
        )
        // `slice` COPIES — a `subarray` view would keep the oversized buffer alive.
        buffered = buffered.slice(buffered.byteLength - EVENT_STREAM_BUFFER_RETAIN_BYTES)
        // We cut mid-part: whatever precedes the next boundary is junk, so the
        // next read resyncs on a boundary exactly like the start of the stream.
        preambleConsumed = false
      }
      const deliveries = read.items.map((item) => classify(item, observedAt))
      const onlyHeartbeats =
        deliveries.length > 0 &&
        buffered.byteLength === 0 &&
        deliveries.every((d) => d.kind === 'heartbeat')
      if (!onlyHeartbeats) {
        handlers.onBytes?.(value.byteLength, new TextDecoder().decode(value.slice(0, 120)))
      }
      for (const d of deliveries) {
        if (d.kind === 'event') handlers.onEvent(d.event)
        else if (d.kind === 'unparsed') handlers.onUnparsedBlock?.(d.reason, d.preview)
      }
    }
  } finally {
    stream.destroy()
  }
}

/**
 * Parse a Dahua event block body. The salient line is a `;`-delimited
 * key=value list, e.g. `Code=VideoMotion;action=Start;index=0`. A
 * trailing multi-line `data={…}` JSON blob (present on some firmwares) is
 * ignored — motion needs only code/action/index. Returns null when no
 * `Code=` line is present.
 *
 * `observedAt` is when the chunk that COMPLETED the part arrived — with parts
 * delivered on completion, that is when the camera sent it.
 */
function parseAmcrestEventBody(body: string, observedAt: number): AmcrestEvent | null {
  const codeLine = body.split(/\r?\n/).find((l) => l.includes('Code=')) ?? ''
  if (!codeLine) return null
  const fields = new Map<string, string>()
  for (const pair of codeLine.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    fields.set(pair.slice(0, eq).trim().toLowerCase(), pair.slice(eq + 1).trim())
  }
  const code = fields.get('code')
  const action = fields.get('action')
  if (!code || !action) return null
  const indexRaw = fields.get('index')
  const index =
    indexRaw !== undefined && /^\d+$/.test(indexRaw) ? Number.parseInt(indexRaw, 10) : null
  return { observedAt, code, action, index, raw: body }
}
