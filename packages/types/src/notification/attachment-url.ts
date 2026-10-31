/**
 * attachment-url — a notification attachment must be an ABSOLUTE URL by the
 * time it leaves the hub.
 *
 * A caller that builds a notification from inside the hub (the admin test
 * panel's sample media) may name an attachment by a root-relative path
 * (`/addon/notifiers/samples/image`). The receiving end — a phone, a push
 * service — resolves a relative path against ITS OWN base and gets a 404. The
 * hub's address for anything that must work from outside is the
 * `local-network` palette's `publicEndpoint` role, read through `ctx.api`; this
 * helper is the one place a relative attachment is resolved against it, shared
 * by every notification-output provider (addons may not import each other).
 *
 * A failure is never silent and the two failure causes are told apart: the
 * palette answering "no public endpoint" is not the same fact as the read
 * failing. Either way the attachment is dropped and the text still goes out.
 */
import type { z } from 'zod'
import type { NotificationSchema } from '../capabilities/notification-output.cap.js'
import type { IScopedLogger } from '../interfaces/logging.js'

type Notification = z.infer<typeof NotificationSchema>

/** What reading the hub's public endpoint produced. */
export type PublicEndpointReading =
  | { readonly kind: 'resolved'; readonly origin: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly error: string }

/** Reads the public endpoint; supplied by the addon over `ctx.api.localNetwork`. */
export type PublicEndpointReader = () => Promise<PublicEndpointReading>

/** The slice of `ctx.api.localNetwork` the reader needs. */
export interface PublicEndpointSource {
  readonly getAddresses: {
    query(): Promise<{
      readonly roles: { readonly publicEndpoint: { readonly resolved: string | null } }
    }>
  }
}

/** Build a {@link PublicEndpointReader} over `local-network.getAddresses`. */
export function publicEndpointReaderFrom(source: PublicEndpointSource): PublicEndpointReader {
  return async () => {
    try {
      const resolved = (await source.getAddresses.query()).roles.publicEndpoint.resolved
      return resolved === null || resolved.length === 0
        ? { kind: 'none' }
        : { kind: 'resolved', origin: resolved }
    } catch (err) {
      return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

/** A root-relative path: `/x`, not `//host/x` and not an absolute URL. */
export function isRootRelativeUrl(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

export interface ResolveAttachmentUrlsDeps {
  readonly notification: Notification
  readonly readPublicEndpoint: PublicEndpointReader
  readonly logger?: IScopedLogger
}

/**
 * Returns the notification with every root-relative attachment URL made
 * absolute on the hub's public endpoint. Absolute URLs and byte attachments
 * pass unchanged; the palette is read only when a relative URL exists.
 */
export async function resolveAttachmentUrls(
  deps: ResolveAttachmentUrlsDeps,
): Promise<Notification> {
  const { notification, logger } = deps
  const attachments = notification.attachments
  if (attachments === undefined) return notification
  if (!attachments.some((a) => a.url !== undefined && isRootRelativeUrl(a.url))) {
    return notification
  }
  const reading = await deps.readPublicEndpoint()
  const tags = notification.deviceId !== undefined ? { deviceId: notification.deviceId } : undefined
  const out: Notification['attachments'] = []
  for (const att of attachments) {
    if (att.url === undefined || !isRootRelativeUrl(att.url)) {
      out.push(att)
      continue
    }
    if (reading.kind === 'resolved') {
      out.push({ ...att, url: new URL(att.url, reading.origin).toString() })
      continue
    }
    const reason =
      reading.kind === 'none'
        ? 'no-public-endpoint: the local-network palette names no public endpoint'
        : `public-endpoint-read-failed: ${reading.error}`
    logger?.warn(`notification attachment dropped (${att.mediaType}): ${reason}`, {
      ...(tags !== undefined ? { tags } : {}),
      meta: { reason: reading.kind === 'none' ? 'no-public-endpoint' : 'read-failed' },
    })
  }
  return { ...notification, attachments: out }
}
