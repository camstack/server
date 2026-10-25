/**
 * `GET /addon/export-alexa/snapshot/<imageId>.jpg?exp=&sig=` — where Alexa
 * fetches a snapshot it was given (R2, D773).
 *
 * The route is `access: 'public'` at the hub (Alexa has no hub session), so
 * this handler IS the gate, in this order:
 *
 *   1. the integration switch is on (off ⇒ 410, every minted URL dies with it);
 *   2. the URL's HMAC and expiry hold and the image is still held (else 410 —
 *      Amazon: an invalid or expired URI is answered 410 and Alexa re-asks);
 *   3. `Authorization: Bearer <token>` is a live account-link token (else 401);
 *   4. that token belongs to the hub user the image was minted for, and that
 *      user may still VIEW the camera (else 403).
 *
 * Never a redirect (Amazon does not follow them), never cached by an
 * intermediary, never compressed by the hub's bridge (an empty brotli body on
 * the forked UDS bridge — `content-encoding: identity`, as the notifier sample
 * routes do).
 */
import type { AddonHttpReply, AddonHttpRequest, IScopedLogger } from '@camstack/types'
import type { SnapshotStore } from './snapshot-store.js'

export interface SnapshotRouteDeps {
  readonly store: SnapshotStore
  readonly enabled: () => boolean
  /** The account-link token's hub user, or null when it does not verify. */
  readonly verifyToken: (token: string) => Promise<{ readonly userId: string } | null>
  /** May this hub user still view this device (S1 gate)? */
  readonly mayView: (userId: string, deviceId: number) => Promise<boolean>
  readonly logger: IScopedLogger
}

const IMAGE_FILE = /^([0-9a-f-]{36})\.jpg$/

function bearerOf(headers: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue
    const match = /^Bearer\s+(.+)$/i.exec(value.trim())
    return match?.[1] ?? null
  }
  return null
}

function refuse(reply: AddonHttpReply, status: number, error: string): void {
  reply
    .code(status)
    .type('application/json')
    .header('cache-control', 'no-store')
    .header('content-encoding', 'identity')
  reply.send({ error })
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value
  return undefined
}

/**
 * Exactly one line per fetch, whatever the answer (D779 amendment): "did Amazon ever
 * fetch the image, and what did it get?" is otherwise unanswerable — a served
 * image used to log nothing. Never the signature, never the token.
 */
function logFetch(
  deps: SnapshotRouteDeps,
  req: AddonHttpRequest,
  started: number,
  outcome: {
    readonly status: number
    readonly imageId?: string
    readonly deviceId?: number
    readonly reason?: string
    readonly lazy?: boolean
    readonly bytes?: number
    readonly extra?: Record<string, unknown>
  },
): void {
  const level = outcome.status === 401 || outcome.status === 403 ? 'warn' : 'info'
  deps.logger[level]('alexa snapshot: fetch answered', {
    ...(outcome.deviceId !== undefined ? { tags: { deviceId: outcome.deviceId } } : {}),
    meta: {
      status: outcome.status,
      ...(outcome.imageId !== undefined ? { imageId: outcome.imageId } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.lazy !== undefined ? { lazy: outcome.lazy } : {}),
      ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
      tookMs: Date.now() - started,
      userAgent: headerOf(req.headers, 'user-agent') ?? null,
      ...outcome.extra,
    },
  })
}

export async function handleSnapshotFetch(
  req: AddonHttpRequest,
  reply: AddonHttpReply,
  deps: SnapshotRouteDeps,
): Promise<void> {
  const started = Date.now()
  if (!deps.enabled()) {
    logFetch(deps, req, started, { status: 410, reason: 'switched-off' })
    refuse(reply, 410, 'snapshots are switched off')
    return
  }
  const match = IMAGE_FILE.exec(req.params['file'] ?? '')
  const imageId = match?.[1]
  if (imageId === undefined) {
    logFetch(deps, req, started, { status: 410, reason: 'not-a-snapshot-address' })
    refuse(reply, 410, 'not a snapshot address')
    return
  }
  const found = deps.store.lookup(imageId, req.query['exp'], req.query['sig'])
  if (found.kind === 'gone') {
    logFetch(deps, req, started, { status: 410, imageId, reason: found.reason })
    refuse(reply, 410, found.reason)
    return
  }
  const image = found.image
  const lazy = image.load !== undefined || image.bytes.byteLength === 0
  const base = { imageId, deviceId: image.deviceId, lazy }
  const token = bearerOf(req.headers)
  const verified = token === null ? null : await deps.verifyToken(token).catch(() => null)
  if (verified === null) {
    logFetch(deps, req, started, {
      ...base,
      status: 401,
      reason: 'no valid account-link token',
      extra: { hadToken: token !== null },
    })
    refuse(reply, 401, 'a valid Alexa account-link token is required')
    return
  }
  if (verified.userId !== image.userId || !(await deps.mayView(verified.userId, image.deviceId))) {
    logFetch(deps, req, started, {
      ...base,
      status: 403,
      reason: 'token of another user, or the user lost the camera',
      extra: { tokenUser: verified.userId, imageUser: image.userId },
    })
    refuse(reply, 403, 'not allowed')
    return
  }
  // A lazy (object-detection) image is read only now, after every check.
  const bytes = await deps.store.bytesOf(image)
  if (bytes === null || bytes.byteLength === 0) {
    logFetch(deps, req, started, { ...base, status: 410, reason: 'no image for this event' })
    refuse(reply, 410, 'no image is available for this event')
    return
  }
  logFetch(deps, req, started, { ...base, status: 200, bytes: bytes.byteLength })
  reply
    .code(200)
    .type(image.contentType)
    .header('cache-control', 'private, no-store')
    .header('content-encoding', 'identity')
    .header('content-length', String(bytes.byteLength))
  reply.send(bytes)
}
