/**
 * Read email images off `peerBytes` tickets and hand the bytes to {@link buildRawMime}.
 *
 * One body, one take (D613). A ticket that cannot be read is reported and left
 * out — the mail still goes, without that image.
 */
import type { PeerBytesOpenResult, PeerBytesTicket } from '../interfaces/addon-peer-bytes.js'
import {
  EMAIL_IMAGE_MAX_TOTAL_BYTES,
  type EmailImagePart,
  type EmailMimeImage,
  type RawMimeInput,
  buildRawMime,
} from './email-mime.js'

export type OpenEmailImage = (ticket: PeerBytesTicket) => Promise<PeerBytesOpenResult>

export type EmailImageDropped = (reason: string, deviceId: number | undefined) => void

/** What a sender knows before the tickets are opened. */
export interface OutboundEmail {
  readonly from: string
  readonly to: string | readonly string[]
  readonly cc?: readonly string[]
  readonly bcc?: readonly string[]
  readonly replyTo?: string
  readonly subject: string
  readonly text: string
  readonly html?: string
  readonly images?: readonly EmailImagePart[]
}

function asBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk)
  throw new Error('email image: unexpected stream chunk')
}

async function readBody(
  opened: Extract<PeerBytesOpenResult, { kind: 'body' }>['body'],
  maxBytes: number,
): Promise<Uint8Array> {
  if (opened.declaredBytes !== null && opened.declaredBytes > maxBytes) {
    opened.cancel('email image over cap')
    throw new Error(`attachment exceeds maxBytes (${opened.declaredBytes} > ${maxBytes})`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of opened.stream) {
    const bytes = asBytes(chunk)
    total += bytes.byteLength
    if (total > maxBytes) {
      opened.cancel('email image over cap')
      throw new Error(`attachment exceeds maxBytes (>${maxBytes})`)
    }
    chunks.push(bytes)
  }
  if (total === 0) throw new Error('email image was empty')
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function readTicket(
  open: OpenEmailImage,
  ticket: PeerBytesTicket,
  maxBytes: number,
): Promise<Uint8Array> {
  const opened = await open(ticket)
  if (opened.kind === 'refused') throw new Error(`email image unavailable: ${opened.code}`)
  return readBody(opened.body, maxBytes)
}

/** The images that fit. Each failure is handed to `onDropped` and skipped. */
export async function materializeEmailImages(
  images: readonly EmailImagePart[] | undefined,
  open: OpenEmailImage,
  onDropped: EmailImageDropped,
): Promise<readonly EmailMimeImage[]> {
  if (images === undefined || images.length === 0) return []
  const out: EmailMimeImage[] = []
  let used = 0
  for (const image of images) {
    const room = EMAIL_IMAGE_MAX_TOTAL_BYTES - used
    if (room <= 0) {
      onDropped('attachment exceeds maxBytes (total cap)', image.deviceId)
      continue
    }
    try {
      const bytes = await readTicket(open, image.ticket, room)
      used += bytes.byteLength
      out.push({
        bytes,
        mime: image.mime,
        name: image.name,
        contentId: image.contentId,
        placement: image.placement,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      onDropped(reason, image.deviceId)
    }
  }
  return out
}

/** Tickets in, one MIME body out. The same call for Gmail and SMTP. */
export async function assembleEmailMime(
  input: OutboundEmail,
  open: OpenEmailImage,
  onDropped: EmailImageDropped,
): Promise<string> {
  const images = await materializeEmailImages(input.images, open, onDropped)
  const rendered: RawMimeInput = {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.cc !== undefined ? { cc: input.cc } : {}),
    ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.html !== undefined ? { html: input.html } : {}),
    ...(images.length > 0 ? { images } : {}),
  }
  return buildRawMime(rendered)
}
