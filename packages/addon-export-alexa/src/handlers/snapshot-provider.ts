/**
 * `Alexa.SmartVision.SnapshotProvider/GetSnapshot` (R2, D773).
 *
 * Answer, within Amazon's 8 s, with a `Snapshot` event whose URI is a signed,
 * ten-minute, account-token-checked image on this hub's public address
 * (`snapshots/snapshot-route.ts`). The frame comes from the `snapshot` cap —
 * its cache, or a fresh capture when the cache is past the camera's own max
 * age — and is always re-encoded to an Alexa-sized JPEG.
 *
 * `preferOnDemandSnapshot` is NOT turned into `force`: the cap documents
 * `force` as an operator-only signal because it wakes a battery camera, and an
 * Alexa tile refresh is not an operator. A doorbell does not support on-demand
 * snapshots anyway (Amazon); the latest frame is what it shows.
 */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { type AlexaJpeg, toAlexaJpeg } from '../snapshots/snapshot-image.js'
import type { SnapshotStore } from '../snapshots/snapshot-store.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import type { DirectiveHeader } from './types.js'

/** Leaves the rest of Amazon's 8 s for the re-encode and the Lambda hop. */
export const SNAPSHOT_READ_TIMEOUT_MS = 5_000

const SnapshotImageSchema = z.object({ base64: z.string().min(1), contentType: z.string() })

export interface SnapshotProviderContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  readonly store: SnapshotStore
  /** The integration switch (default on). */
  readonly enabled: () => boolean
  /** The hub's public HTTPS origin, the one the Lambda already reaches. */
  readonly publicHubUrl: () => string
  /** Injectable for tests; production re-encodes with sharp. */
  readonly encode?: (bytes: Buffer) => Promise<AlexaJpeg>
  readonly now?: () => number
}

function snapshotError(header: DirectiveHeader, type: string, message: string): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa.SmartVision.SnapshotProvider',
        name: 'ErrorResponse',
        messageId: header.messageId,
        ...(header.correlationToken !== undefined
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '1.1',
      },
      payload: { type, message },
    },
  }
}

async function readFrame(ctx: AddonContext, deviceId: number): Promise<Buffer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SNAPSHOT_READ_TIMEOUT_MS)
  })
  try {
    const raw = await Promise.race([ctx.api.snapshot.getSnapshot.query({ deviceId }), timeout])
    const parsed = SnapshotImageSchema.safeParse(raw)
    return parsed.success ? Buffer.from(parsed.data.base64, 'base64') : null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function handleGetSnapshot(
  header: DirectiveHeader,
  endpoint: { readonly endpointId: string } | undefined,
  deps: SnapshotProviderContext,
  caller: VerifiedDirectiveIdentity,
): Promise<unknown> {
  if (endpoint === undefined) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'missing endpoint')
  }
  if (!deps.enabled()) {
    return snapshotError(header, 'DISABLED_BY_USER', 'snapshots are switched off on this hub')
  }
  const parsed = parseCameraEndpointId(endpoint.endpointId)
  if (parsed.kind !== 'camera') {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'snapshots are served for camera endpoints')
  }
  const deviceId = parsed.deviceId
  const base = deps.publicHubUrl().replace(/\/+$/, '')
  if (!base.startsWith('https://')) {
    deps.logger.warn('alexa snapshot: no public HTTPS address — Alexa cannot fetch an image', {
      tags: { deviceId },
    })
    return errorEnvelope(header, 'INTERNAL_ERROR', 'the hub has no public HTTPS address')
  }
  const started = deps.now?.() ?? Date.now()
  const frame = await readFrame(deps.ctx, deviceId).catch((err: unknown) => {
    deps.logger.warn('alexa snapshot: snapshot read failed', {
      tags: { deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  })
  if (frame === null) {
    return errorEnvelope(header, 'ENDPOINT_UNREACHABLE', `no snapshot from device ${deviceId}`)
  }
  let jpeg: AlexaJpeg
  try {
    jpeg = await (deps.encode ?? toAlexaJpeg)(frame)
  } catch (err) {
    deps.logger.warn('alexa snapshot: re-encode failed — not sending the original frame', {
      tags: { deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return errorEnvelope(header, 'INTERNAL_ERROR', 'snapshot could not be prepared')
  }
  const now = deps.now?.() ?? Date.now()
  const minted = deps.store.mint({
    deviceId,
    userId: caller.userId,
    bytes: jpeg.bytes,
    capturedAt: now,
  })
  deps.logger.info('alexa snapshot: served', {
    tags: { deviceId },
    meta: {
      userId: caller.userId,
      bytes: jpeg.bytes.length,
      width: jpeg.width,
      height: jpeg.height,
      tookMs: now - started,
    },
  })
  return {
    event: {
      header: {
        namespace: 'Alexa.SmartVision.SnapshotProvider',
        name: 'Snapshot',
        messageId: header.messageId,
        ...(header.correlationToken !== undefined
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '1.1',
      },
      endpoint: { endpointId: endpoint.endpointId },
      payload: {
        value: {
          uri: `${base}${minted.path}`,
          uriExpirationTime: new Date(minted.expiresAt).toISOString(),
          authenticationType: 'ACCESS_TOKEN',
        },
        timeOfSample: new Date(now).toISOString(),
        // The cap may answer from its cache; the frame's exact age is not
        // carried on the read, so the uncertainty is the cache's order of size.
        uncertaintyInMilliseconds: 10_000,
      },
    },
  }
}
