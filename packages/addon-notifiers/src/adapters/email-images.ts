/**
 * The images an email will carry.
 *
 * Bytes are fetched here, the same way the other image notifiers resolve a
 * `needsFetch` attachment (`fetchAttachmentBytes`, hard cap). They leave this
 * addon as a `peerBytes` ticket — never a byte field on `smtp-provider` (D613).
 * A fetch that fails or does not fit is logged and skipped; the mail still sends.
 */
import type {
  AddonPeerBytes,
  EmailImagePart,
  IScopedLogger,
  PreparedNotification,
} from '@camstack/types'
import { EMAIL_IMAGE_MAX_COUNT, EMAIL_IMAGE_MAX_TOTAL_BYTES } from '@camstack/types'
import { type FetchedAttachment, fetchAttachmentBytes } from '../http.js'

export interface EmailAdapterDeps {
  readonly fetchAttachment?: (url: string, maxBytes: number) => Promise<FetchedAttachment>
  readonly peerBytes?: Pick<AddonPeerBytes, 'offerBuffer'>
  readonly logger?: Pick<IScopedLogger, 'warn'>
}

interface HeldImage {
  readonly bytes: Uint8Array
  readonly mime: string
  readonly name: string
}

function omit(
  logger: Pick<IScopedLogger, 'warn'> | undefined,
  reason: string,
  deviceId: number | undefined,
): void {
  logger?.warn(`email image omitted: ${reason}`, {
    meta: { reason },
    ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
  })
}

function safeReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('://')) return 'email image fetch failed'
  return message
}

function imageMime(value: string | undefined): string {
  const base = value?.split(';')[0]?.trim().toLowerCase()
  if (base !== undefined && base.startsWith('image/')) return base
  return 'image/jpeg'
}

function imageName(value: string | undefined): string {
  const base = value
    ?.split('/')
    .pop()
    ?.replace(/[\r\n"]/g, '')
    .trim()
  if (base !== undefined && base.length > 0) return base
  return 'image.jpg'
}

async function holdImage(
  prepared: PreparedNotification['attachments'][number],
  room: number,
  fetchAttachment: (url: string, maxBytes: number) => Promise<FetchedAttachment>,
  logger: Pick<IScopedLogger, 'warn'> | undefined,
  deviceId: number | undefined,
): Promise<HeldImage | undefined> {
  if (prepared.bytes !== undefined) {
    if (prepared.bytes.byteLength > room) {
      omit(logger, `attachment exceeds maxBytes (${prepared.bytes.byteLength} > ${room})`, deviceId)
      return undefined
    }
    if (prepared.bytes.byteLength === 0) {
      omit(logger, 'email image was empty', deviceId)
      return undefined
    }
    return {
      bytes: prepared.bytes,
      mime: imageMime(prepared.mime),
      name: imageName(prepared.name),
    }
  }
  if (prepared.url === undefined) {
    omit(logger, 'email image had no bytes and no url', deviceId)
    return undefined
  }
  try {
    const fetched = await fetchAttachment(prepared.url, room)
    return {
      bytes: fetched.bytes,
      mime: imageMime(prepared.mime ?? fetched.mime),
      name: imageName(prepared.name ?? fetched.name),
    }
  } catch (err) {
    omit(logger, safeReason(err), deviceId)
    return undefined
  }
}

async function offerImage(
  held: HeldImage,
  placement: EmailImagePart['placement'],
  contentId: string,
  deviceId: number | undefined,
  deps: EmailAdapterDeps,
): Promise<EmailImagePart | undefined> {
  const peer = deps.peerBytes
  if (peer === undefined) {
    omit(deps.logger, 'no byte transport', deviceId)
    return undefined
  }
  const offered = await peer.offerBuffer({
    bytes: Buffer.from(held.bytes),
    contentType: held.mime,
    label: 'email-image',
    ...(deviceId !== undefined ? { deviceId } : {}),
  })
  if (offered.kind === 'refused') {
    omit(deps.logger, offered.code, deviceId)
    return undefined
  }
  return {
    ticket: offered.ticket,
    mime: held.mime,
    name: held.name,
    contentId,
    placement,
    ...(deviceId !== undefined ? { deviceId } : {}),
  }
}

/** Up to {@link EMAIL_IMAGE_MAX_COUNT} images, within the total byte cap. */
export async function emailImagesFor(
  prepared: PreparedNotification,
  deps: EmailAdapterDeps,
): Promise<readonly EmailImagePart[]> {
  const fetchAttachment = deps.fetchAttachment ?? fetchAttachmentBytes
  const placement: EmailImagePart['placement'] =
    prepared.format === 'html' ? 'inline' : 'attachment'
  const deviceId = prepared.deviceId
  const out: EmailImagePart[] = []
  let used = 0
  for (const attachment of prepared.attachments) {
    if (attachment.mediaType !== 'image') continue
    if (out.length >= EMAIL_IMAGE_MAX_COUNT) break
    const room = EMAIL_IMAGE_MAX_TOTAL_BYTES - used
    const held = await holdImage(attachment, room, fetchAttachment, deps.logger, deviceId)
    if (held === undefined) continue
    const contentId = `camstack-image-${out.length + 1}`
    const offered = await offerImage(held, placement, contentId, deviceId, deps)
    if (offered === undefined) continue
    used += held.bytes.byteLength
    out.push(offered)
  }
  return out
}
