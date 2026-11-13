/**
 * One RFC 5322 body for every mail sender.
 *
 * Gmail and the SMTP relay both call this. An HTML message with an inline image is
 * `multipart/related` (the HTML sits in `multipart/alternative` and references
 * `cid:`). A text message carries the same bytes as a normal attachment
 * (`multipart/mixed`). The image bytes are already in hand — a sender reads them
 * off a `peerBytes` ticket before calling in ({@link assembleEmailMime}).
 */
import { z } from 'zod'
import { PeerBytesTicketSchema, type PeerBytesTicket } from '../interfaces/addon-peer-bytes.js'

/** How many images one email will carry. */
export const EMAIL_IMAGE_MAX_COUNT: number = 3

/** Total image bytes one email will carry. */
export const EMAIL_IMAGE_MAX_TOTAL_BYTES: number = 5 * 1024 * 1024

/**
 * Where an HTML body leaves room for the inline images: under the text, above
 * the click link. The builder replaces it; a message with no image loses it.
 */
export const EMAIL_IMAGE_SLOT: string = '<!--camstack-images-->'

/** An image a sender still has to read (`peerBytes` ticket, not the bytes). */
export interface EmailImagePart {
  readonly ticket: PeerBytesTicket
  readonly mime: string
  readonly name: string
  readonly contentId: string
  readonly placement: 'inline' | 'attachment'
  readonly deviceId?: number
}

export const EmailImagePartSchema: z.ZodType<EmailImagePart> = z.object({
  ticket: PeerBytesTicketSchema,
  mime: z.string().min(1),
  name: z.string().min(1),
  contentId: z.string().min(1),
  placement: z.enum(['inline', 'attachment']),
  deviceId: z.number().int().nonnegative().optional(),
})

/** An image whose bytes are already in hand, ready for the MIME body. */
export interface EmailMimeImage {
  readonly bytes: Uint8Array
  readonly mime: string
  readonly name: string
  readonly contentId: string
  readonly placement: 'inline' | 'attachment'
}

/** The headers and bodies `buildRawMime` renders. `images` are bytes, not tickets. */
export interface RawMimeInput {
  readonly from: string
  readonly to: string | readonly string[]
  readonly cc?: readonly string[]
  readonly bcc?: readonly string[]
  readonly replyTo?: string
  readonly subject: string
  readonly text: string
  readonly html?: string
  readonly images?: readonly EmailMimeImage[]
}

let mimeSeq = 0

function nextBoundary(kind: string): string {
  mimeSeq += 1
  return `camstack_${kind}_${mimeSeq.toString(36)}_${Date.now().toString(36)}`
}

function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function formatAddressList(addrs: string | readonly string[]): string {
  return (Array.isArray(addrs) ? addrs : [addrs]).join(', ')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function safeToken(value: string, fallback: string): string {
  const cleaned = value.replace(/[\r\n"]/g, '').trim()
  return cleaned.length > 0 ? cleaned : fallback
}

function base64Body(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))
  return lines.join('\r\n')
}

function imgTag(image: EmailMimeImage): string {
  return `<img src="cid:${escapeHtml(image.contentId)}" alt="">`
}

function fillSlot(html: string, inline: readonly EmailMimeImage[]): string {
  return html.replaceAll(EMAIL_IMAGE_SLOT, inline.map(imgTag).join(''))
}

function headerLines(input: RawMimeInput): string[] {
  const lines: string[] = [`From: ${input.from}`, `To: ${formatAddressList(input.to)}`]
  if (input.cc !== undefined && input.cc.length > 0)
    lines.push(`Cc: ${formatAddressList(input.cc)}`)
  if (input.bcc !== undefined && input.bcc.length > 0) {
    lines.push(`Bcc: ${formatAddressList(input.bcc)}`)
  }
  if (input.replyTo !== undefined && input.replyTo.length > 0)
    lines.push(`Reply-To: ${input.replyTo}`)
  lines.push(`Subject: ${encodeHeaderWord(input.subject)}`)
  lines.push('MIME-Version: 1.0')
  return lines
}

function textPart(boundary: string, text: string): string[] {
  return [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
  ]
}

function htmlPart(boundary: string, html: string): string[] {
  return [
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
  ]
}

function imagePart(boundary: string, image: EmailMimeImage): string[] {
  const mime = safeToken(image.mime, 'image/jpeg')
  const name = safeToken(image.name, 'image.jpg')
  const disposition = image.placement === 'inline' ? 'inline' : 'attachment'
  const lines = [
    `--${boundary}`,
    `Content-Type: ${mime}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${disposition}; filename="${name}"`,
  ]
  if (image.placement === 'inline')
    lines.push(`Content-ID: <${safeToken(image.contentId, 'image')}>`)
  lines.push('', base64Body(image.bytes))
  return lines
}

function alternative(outer: string, text: string, html: string): string[] {
  const inner = nextBoundary('alt')
  return [
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
    ...textPart(inner, text),
    ...htmlPart(inner, html),
    `--${inner}--`,
  ]
}

function simpleMessage(input: RawMimeInput, html: string | undefined): string[] {
  const lines = headerLines(input)
  if (html !== undefined) {
    const boundary = nextBoundary('alt')
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '')
    lines.push(...textPart(boundary, input.text), ...htmlPart(boundary, html), `--${boundary}--`)
    return lines
  }
  lines.push(
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.text,
  )
  return lines
}

function mixedMessage(
  input: RawMimeInput,
  html: string | undefined,
  files: readonly EmailMimeImage[],
): string[] {
  const boundary = nextBoundary('mix')
  const lines = headerLines(input)
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '')
  if (html !== undefined) lines.push(...alternative(boundary, input.text, html))
  else lines.push(...textPart(boundary, input.text))
  for (const image of files) lines.push(...imagePart(boundary, image))
  lines.push(`--${boundary}--`)
  return lines
}

function relatedMessage(
  input: RawMimeInput,
  html: string,
  inline: readonly EmailMimeImage[],
  attached: readonly EmailMimeImage[],
): string[] {
  const boundary = nextBoundary('rel')
  const lines = headerLines(input)
  lines.push(
    `Content-Type: multipart/related; boundary="${boundary}"; type="multipart/alternative"`,
    '',
    ...alternative(boundary, input.text, html),
  )
  for (const image of inline) lines.push(...imagePart(boundary, image))
  for (const image of attached) lines.push(...imagePart(boundary, image))
  lines.push(`--${boundary}--`)
  return lines
}

/** Render one mail. No I/O: the caller has already decided which images survived. */
export function buildRawMime(input: RawMimeInput): string {
  const images = input.images ?? []
  const inline = images.filter((image) => image.placement === 'inline')
  const attached = images.filter((image) => image.placement === 'attachment')
  const html =
    input.html !== undefined && input.html.length > 0 ? fillSlot(input.html, inline) : undefined
  if (html !== undefined && inline.length > 0)
    return relatedMessage(input, html, inline, attached).join('\r\n')
  if (attached.length > 0 || inline.length > 0) {
    const files = attached.length > 0 ? attached : inline
    return mixedMessage(input, html, files).join('\r\n')
  }
  return simpleMessage(input, html).join('\r\n')
}
