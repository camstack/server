/**
 * Resolving a test-chat attachment: a REFERENCE in, bytes out, server-side.
 *
 * The browser never uploads pixels. It names a `deviceId` or a `trackId` and
 * this module fetches them through the caps that already own them. That is not
 * a preference: `useDeviceSnapshotImage` was rewritten to stop putting 758 KB
 * average camera captures through the msgpack websocket for a 28 px `<img>`,
 * and a chat composer is precisely where that mistake comes back.
 *
 * Every failure branch LOGS before it returns, with the reason that tells the
 * two remedies apart. A test chat that answers "no image" with silence reads
 * exactly like a model that had nothing to say.
 */
import type { IScopedLogger, LlmErrorCode, MediaFileKind } from '@camstack/types'
import type { TestChatAttachment, TestChatImageRef, TestChatMessage } from './contract.js'

/**
 * Which stored media a track attachment is allowed to be, best first.
 *
 * `keyFrameSmall` wins because it is the CLEAN best-shot (no drawn box) at a
 * size a vision model actually ingests — a boxed frame teaches the model to
 * describe the annotation, and the native `keyFrame` is megabytes for no gain.
 * The subject crops come next for a track whose key frame was never written,
 * and `fullFrameBoxed` is absent on purpose: it is the one variant with
 * graphics painted over the evidence.
 */
export const TRACK_MEDIA_PREFERENCE: readonly MediaFileKind[] = [
  'keyFrameSmall',
  'keyFrame',
  'thumbnailSmall',
  'thumbnail',
  'crop',
]

/** One stored media row, narrowed to what this surface reads. */
export interface TrackMediaRow {
  /** The media row's own id (D482) — the address, never a composite key. */
  readonly mediaId: number
  readonly kind: string
  readonly base64: string
  readonly sizeBytes: number
  readonly timestamp: number
}

export interface SnapshotImage {
  readonly base64: string
  readonly contentType: string
}

export interface VisionImage {
  /** `Uint8Array<ArrayBuffer>` — the sanctioned binary convention (`LlmImage`),
   *  and NOT plain `Uint8Array`: a `SharedArrayBuffer`-backed view would not
   *  survive the msgpack/superjson seam the cap's images travel over. */
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly mimeType: string
}

export interface MediaDeps {
  /** `snapshot.getSnapshot({ deviceId })` — cache-first, never `force`. */
  readonly getSnapshot: (deviceId: number) => Promise<SnapshotImage | null>
  /** `pipelineAnalytics.getTrackMedia({ trackId, kinds, deviceId })`. */
  readonly getTrackMedia: (
    trackId: string,
    kinds: readonly MediaFileKind[],
    deviceId: number,
  ) => Promise<readonly TrackMediaRow[]>
  readonly logger: IScopedLogger
}

/** JPEG is what every media row and every snapshot in this system is. */
const DEFAULT_MIME = 'image/jpeg'

export interface ResolveFailure {
  readonly code: LlmErrorCode
  readonly message: string
}

export interface ResolvedImage {
  readonly image: VisionImage
  readonly attachment: TestChatAttachment
}

export type ResolveOutcome =
  | { readonly ok: true; readonly resolved: ResolvedImage }
  | { readonly ok: false; readonly failure: ResolveFailure }

/**
 * Flatten the transcript into the single prompt the chat-completions wire takes
 * as one user turn.
 *
 * A SINGLE user turn is sent verbatim: prefixing one message with `User:`
 * teaches small local models to answer in the same transcript format, which
 * makes the very first test a confusing one.
 */
export function renderTranscript(messages: readonly TestChatMessage[]): string {
  if (messages.length === 1 && messages[0]!.role === 'user') return messages[0]!.content
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}

/** The highest-preference media row present, or null when none qualifies. */
export function pickTrackMedia(rows: readonly TrackMediaRow[]): TrackMediaRow | null {
  for (const kind of TRACK_MEDIA_PREFERENCE) {
    const hit = rows.find((r) => r.kind === kind)
    if (hit !== undefined) return hit
  }
  return null
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(base64, 'base64')
  const bytes = new Uint8Array(new ArrayBuffer(buf.byteLength))
  bytes.set(buf)
  return bytes
}

export async function resolveImage(
  deps: MediaDeps,
  ref: TestChatImageRef,
): Promise<ResolveOutcome> {
  if (ref.kind === 'snapshot') {
    const tags = { deviceId: ref.deviceId }
    let shot: SnapshotImage | null
    try {
      shot = await deps.getSnapshot(ref.deviceId)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      deps.logger.warn('ai test chat: snapshot read failed — turn dropped', {
        tags,
        meta: { error: message },
      })
      return {
        ok: false,
        failure: { code: 'unavailable', message: `snapshot unavailable: ${message}` },
      }
    }
    if (shot === null) {
      deps.logger.warn('ai test chat: camera has no frame — turn dropped', { tags })
      return {
        ok: false,
        failure: { code: 'unavailable', message: 'this camera has produced no frame yet' },
      }
    }
    const bytes = decode(shot.base64)
    const mimeType = shot.contentType.length > 0 ? shot.contentType : DEFAULT_MIME
    return {
      ok: true,
      resolved: {
        image: { bytes, mimeType },
        attachment: { kind: 'snapshot', mimeType, sizeBytes: bytes.byteLength },
      },
    }
  }

  let rows: readonly TrackMediaRow[]
  try {
    rows = await deps.getTrackMedia(ref.trackId, TRACK_MEDIA_PREFERENCE, ref.deviceId)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    deps.logger.warn('ai test chat: track media read failed — turn dropped', {
      meta: { trackId: ref.trackId, error: message },
    })
    return {
      ok: false,
      failure: { code: 'unavailable', message: `track media unavailable: ${message}` },
    }
  }
  const row = pickTrackMedia(rows)
  if (row === null) {
    deps.logger.warn('ai test chat: track has no usable media — turn dropped', {
      meta: { trackId: ref.trackId, kindsFound: rows.map((r) => r.kind) },
    })
    return {
      ok: false,
      failure: {
        code: 'unavailable',
        message: 'this track has no stored best-shot left (evicted or never written)',
      },
    }
  }
  const bytes = decode(row.base64)
  return {
    ok: true,
    resolved: {
      image: { bytes, mimeType: DEFAULT_MIME },
      attachment: {
        kind: 'track',
        mimeType: DEFAULT_MIME,
        sizeBytes: bytes.byteLength,
        mediaKind: row.kind,
        capturedAt: row.timestamp,
      },
    },
  }
}
