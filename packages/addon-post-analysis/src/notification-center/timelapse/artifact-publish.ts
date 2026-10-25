/**
 * The timelapse artifact seam: a rendered export → a link a notifier BACKEND
 * can fetch.
 *
 * Why this exists at all. `recordingExport` serves its download route
 * `access: 'authenticated'` and answers a RELATIVE path — perfect for the
 * person holding the phone, useless for Zentik/gotify/WhatsApp, which fetch
 * the attachment themselves holding no session. Every url-mode target
 * therefore received a timelapse with NO media (`attachment:noUrl` in the
 * degrade engine) while the notification looked delivered.
 *
 * What it does NOT do is invent a second public-link mechanism. The bytes are
 * republished on the SAME notification artifact plane a detection rule's still
 * and clip already ride: HMAC-signed URL, 24 h expiry, bounded scratch store.
 * One public surface, one signing scheme, one thing to get wrong.
 *
 * The move is a COPY, and copies have a ceiling: `RECORDING_EXPORT_MAX_READ_BYTES`
 * is the provider's bound and it is the bound checked here too — the same
 * constant, not a second policy. Above it there is no attachment and there is
 * a log line saying so, per camera.
 *
 * The SAME read also feeds the PREVIEW still (`renderPreview`) — one base64
 * crossing of the process boundary, two artifacts. Reading the video twice to
 * caption one frame of it would double the envelope on every window.
 *
 * Everything here is best-effort and NOTHING throws: the renderer treats a
 * `null` as "deliver text-only", and a window that failed to publish a link
 * must not be left unstamped to re-render the same eight hours on the next
 * tick.
 */
import { Buffer } from 'node:buffer'
import type { ExportBytes, IScopedLogger, TimelapsePreviewMode } from '@camstack/types'
import { RECORDING_EXPORT_MAX_READ_BYTES } from '@camstack/types'
import type { NcArtifactPublishMeta } from '../artifact-index.js'
import type { NcArtifactPublication } from '../artifact-plane.js'
import type { TimelapseArtifactRef } from './timelapse-delivery.js'

/**
 * Filename a notifier shows for the preview, by what it ACTUALLY is.
 *
 * Keyed on the renderer's answered mime and not on the rule's requested mode:
 * an animation that degraded to a still is a still, and naming it `.gif` is how
 * a recipient's client ends up refusing to display a perfectly good JPEG.
 */
const PREVIEW_NAME_BY_MIME: Readonly<Record<string, string>> = {
  'image/gif': 'timelapse-preview.gif',
  'image/jpeg': 'timelapse-preview.jpg',
}
const PREVIEW_FALLBACK_NAME = 'timelapse-preview.jpg'

/** What one preview render answers: the bytes, and what they turned out to be. */
export interface TimelapsePreviewResult {
  readonly bytes: Uint8Array
  /** `image/jpeg` or `image/gif` — the renderer's answer, never the ask. */
  readonly mime: string
}

export interface TimelapseArtifactPublishPorts {
  readonly logger: IScopedLogger
  /** `recordingExport.readExportBytes` — refuses anything not ready, expired
   *  or over the ceiling, so a thrown error here is an ANSWER, not a fault. */
  readonly readExportBytes: (input: { readonly exportId: string }) => Promise<ExportBytes>
  /**
   * `NcArtifactPlane.publishIndexed` — retains the bytes, files them in the
   * viewer's artefact index, and mints the signed link a notifier backend
   * fetches. `url: null` when no reachable base URL exists (bytes-only, as
   * before); `artifactId: null` when this node hosts no index.
   */
  readonly publish: (
    bytes: Uint8Array,
    mime: string,
    meta: NcArtifactPublishMeta,
  ) => Promise<NcArtifactPublication>
  /**
   * Captioned still out of the SAME bytes — the notification card's picture.
   *
   * Optional, and it takes the bytes rather than the export id ON PURPOSE: the
   * mp4 is read across a process boundary as base64 and a 1.1 MB video costs
   * ~1.5 MB of envelope each way. One read, two artifacts. A second
   * `readExportBytes` for the preview would double that on every window.
   */
  readonly renderPreview?: (input: {
    readonly mp4: Uint8Array
    readonly text: string
    readonly deviceId: number
    /** Still or animation. Always concrete — a rule that names no mode gets
     *  `'image'` here, because an old rule must not start producing GIFs. */
    readonly mode: TimelapsePreviewMode
  }) => Promise<TimelapsePreviewResult | null>
}

export interface TimelapseArtifactPublishRequest {
  readonly exportId: string
  readonly deviceId: number
  /** Already-rendered caption for the preview frame. Absent ⇒ no preview. */
  readonly previewText?: string
  /** Still or animation. Absent ⇒ the still. */
  readonly previewMode?: TimelapsePreviewMode
  /** What the video is ABOUT — the window's end. Absent ⇒ publication time,
   *  which puts a 06:05 render of last night in the wrong morning. */
  readonly capturedAt?: number
  readonly ruleId?: string
  readonly ruleName?: string
  /** The rule's owner. Absent ⇒ a global artefact every caller may browse. */
  readonly ownerUserId?: string
}

/**
 * What one window publishes: the video a notifier fetches, and the still a
 * notification card shows. Either may be null independently — a preview that
 * could not be made never costs the video, and a video that could not be
 * published never costs the preview.
 */
export interface TimelapseArtifactSet {
  readonly video: TimelapseArtifactRef | null
  readonly preview: TimelapseArtifactRef | null
}

/**
 * Build the renderer's `publishArtifact` port.
 *
 * @returns a function answering the {@link TimelapseArtifactSet}. Every null
 *          member has a logged reason. It never rejects.
 */
export function buildTimelapseArtifactPublisher(
  ports: TimelapseArtifactPublishPorts,
): (input: TimelapseArtifactPublishRequest) => Promise<TimelapseArtifactSet> {
  return async (request): Promise<TimelapseArtifactSet> => {
    const { exportId, deviceId, previewText, previewMode } = request
    const tags = { deviceId }
    const none: TimelapseArtifactSet = { video: null, preview: null }
    let read: ExportBytes
    try {
      read = await ports.readExportBytes({ exportId })
    } catch (err: unknown) {
      // The provider's refusals land here: not ready, expired, file gone, too
      // large. All of them mean the same thing to a recipient — no video
      // attached — and all of them must say why.
      ports.logger.warn('timelapse artifact not published: export bytes unavailable', {
        tags,
        meta: { exportId, error: String(err) },
      })
      return none
    }
    if (read.bytes > RECORDING_EXPORT_MAX_READ_BYTES) {
      // Reachable only if a provider ever stopped enforcing its own bound.
      // Checked anyway, and against the SAME constant: the cost of trusting it
      // is a multi-hundred-megabyte write into a scratch directory sized for
      // JPEGs.
      ports.logger.warn('timelapse artifact not published: video too large to republish', {
        tags,
        meta: { exportId, bytes: read.bytes, maxBytes: RECORDING_EXPORT_MAX_READ_BYTES },
      })
      return none
    }
    const mp4 = Buffer.from(read.base64, 'base64')
    // The window's end, not the render's clock: a 06:05 render is about last
    // night, and a library sorted by publication time files it in the wrong
    // morning.
    const capturedAt = request.capturedAt ?? Date.now()
    const common: Omit<NcArtifactPublishMeta, 'kind'> = {
      deviceId,
      deviceIds: [deviceId],
      capturedAt,
      ...(request.ruleId !== undefined ? { ruleId: request.ruleId } : {}),
      ...(request.ruleName !== undefined ? { ruleName: request.ruleName } : {}),
      ...(request.ownerUserId !== undefined ? { ownerUserId: request.ownerUserId } : {}),
    }
    // The PREVIEW is published first because the video row names it as its
    // poster: a list of timelapses is a wall of video thumbnails, and the only
    // still that exists for a window is the one rendered from it.
    const preview = await publishPreview(ports, {
      mp4,
      deviceId,
      tags,
      previewText,
      previewMode: previewMode ?? 'image',
      meta: { ...common, kind: 'timelapse-preview' },
    })
    try {
      const { url } = await ports.publish(mp4, read.contentType, {
        ...common,
        kind: 'timelapse',
        ...(preview.artifactId !== null ? { posterArtifactId: preview.artifactId } : {}),
      })
      if (url === null) {
        // No non-loopback endpoint. The recipient still gets the text and the
        // session-gated tap-through; only the fetchable attachment is lost.
        ports.logger.warn('timelapse artifact not published: no reachable public endpoint', {
          tags,
          meta: { exportId },
        })
        return { video: null, preview: preview.ref }
      }
      ports.logger.info('timelapse artifact published', {
        tags,
        meta: { exportId, bytes: read.bytes, name: read.name, preview: preview.ref !== null },
      })
      return { video: { url, mime: read.contentType, name: read.name }, preview: preview.ref }
    } catch (err: unknown) {
      ports.logger.warn('timelapse artifact not published: artifact plane refused the bytes', {
        tags,
        meta: { exportId, error: String(err) },
      })
      return { video: null, preview: preview.ref }
    }
  }
}

/**
 * What the preview half answers.
 *
 * The two members fail INDEPENDENTLY, and that is the point: on a LAN-only
 * install there is no signed link to attach (`ref: null`) but the still is
 * still filed, so the viewer's timelapse row keeps the only thumbnail that will
 * ever exist for that window. Collapsing them would make the artifact library
 * lose its posters exactly on the installs with no tunnel.
 */
interface PreviewPublication {
  readonly ref: TimelapseArtifactRef | null
  readonly artifactId: string | null
}

const NO_PREVIEW: PreviewPublication = { ref: null, artifactId: null }

/**
 * The preview half. Best-effort at every step and never throws: the picture is
 * an enhancement, the video is the notification.
 */
async function publishPreview(
  ports: TimelapseArtifactPublishPorts,
  input: {
    readonly mp4: Uint8Array
    readonly deviceId: number
    readonly tags: { readonly deviceId: number }
    readonly previewText: string | undefined
    readonly previewMode: TimelapsePreviewMode
    readonly meta: NcArtifactPublishMeta
  },
): Promise<PreviewPublication> {
  const render = ports.renderPreview
  if (render === undefined || input.previewText === undefined) return NO_PREVIEW
  try {
    const rendered = await render({
      mp4: input.mp4,
      text: input.previewText,
      deviceId: input.deviceId,
      mode: input.previewMode,
    })
    if (rendered === null) return NO_PREVIEW
    const { url, artifactId } = await ports.publish(rendered.bytes, rendered.mime, input.meta)
    if (url === null) {
      ports.logger.warn('timelapse preview not published: no reachable public endpoint', {
        tags: input.tags,
      })
      return { ref: null, artifactId }
    }
    return {
      ref: {
        url,
        mime: rendered.mime,
        name: PREVIEW_NAME_BY_MIME[rendered.mime] ?? PREVIEW_FALLBACK_NAME,
      },
      artifactId,
    }
  } catch (err: unknown) {
    ports.logger.warn('timelapse preview not published: publish threw', {
      tags: input.tags,
      meta: { error: String(err) },
    })
    return NO_PREVIEW
  }
}
