/**
 * Data-plane handler for the debug bundle.
 *
 * `/addon/pipeline-analytics/debug-export?deviceIds=101,102`
 *
 * The bytes leave through the data plane and not through a cap or a custom
 * action for the reason the training exports already record: those channels are
 * unary, and an archive base64'd through an RPC envelope is held whole in memory
 * twice on a hub this repo has already OOM'd once. Here the handler owns the
 * real `ServerResponse`, so backpressure and client-disconnect are Node's
 * problem.
 *
 * Admin-only (level declared in `../data-plane-access.ts`). Deliberately NO `Accept-Ranges` — the archive is generated
 * on the fly, and a resumed download would silently receive a DIFFERENT archive
 * if a track were marked or evicted in between.
 *
 * `HEAD` answers the cheap question — how many tracks and how many media files —
 * without moving a byte, which is what lets the button say what it is about to
 * download.
 *
 * Unlike the retrain export this handler stamps NOTHING. A debug export is a
 * read: it must be repeatable, and an operator who downloads twice must get the
 * same bundle both times.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler, IScopedLogger } from '@camstack/types'
import { MAX_EXPORT_BYTES } from './debug-actions.js'
import {
  DEBUG_ANALYSIS_ENTRY,
  DEBUG_EVENTS_ENTRY,
  DEBUG_MANIFEST_ENTRY,
  DEBUG_RETENTION_NOTE,
  DEBUG_TRACK_ENTRY,
  type DebugBundleManifest,
  type DebugBundlePlan,
  type DebugManifestTrack,
  debugArchiveFilename,
  debugTrackDir,
  parseDebugDeviceIds,
} from './debug-bundle.js'
import { ZipStreamWriter } from './zip-stream.js'

/**
 * Pacing. The export is a BACKGROUND job sharing a thread with live decode, so
 * it yields twice: between tracks, and between individual media files.
 *
 * The per-file yield is the one that matters. A track can own twenty blobs, and
 * reading them back to back — each a base64 decode of a few hundred KB —
 * occupies the loop for long enough that snapshot resizes start timing out. One
 * file at a time, with a gap, keeps the export off the critical path; it is slow
 * on purpose.
 */
const TRACK_PACING_MS = 25
const MEDIA_PACING_MS = 15

export interface DebugExportHandlerDeps {
  /** Index reads only — no blob is touched to produce this. */
  readonly buildPlan: (deviceIds: readonly number[]) => Promise<DebugBundlePlan>
  /** One media blob by the row's own id (D482). `null` when the row exists but
   *  the file does not. */
  readonly readMedia: (mediaId: number) => Promise<Buffer | null>
  readonly logger: IScopedLogger
  readonly now: () => number
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8')
}

/** Total media rows the plan hopes to ship — the number HEAD reports. */
function plannedMediaCount(plan: DebugBundlePlan): number {
  let total = 0
  for (const t of plan.tracks) total += t.media.length
  return total
}

export function createDebugExportHandler(deps: DebugExportHandlerDeps): DataPlaneHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    const deviceIds = parseDebugDeviceIds(req.url ?? '')
    let plan: DebugBundlePlan
    try {
      plan = await deps.buildPlan(deviceIds)
    } catch (err) {
      deps.logger.warn('debug export plan failed', { meta: { error: String(err) } })
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('debug export plan failed')
      return
    }

    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${debugArchiveFilename(deps.now())}"`,
      'cache-control': 'no-store',
      'x-camstack-debug-tracks': String(plan.tracks.length),
      'x-camstack-debug-media': String(plannedMediaCount(plan)),
    })
    if (method === 'HEAD') {
      res.end()
      return
    }

    // Settles on whichever comes first: the flush callback, or `drain` after a
    // full buffer. The callback deliberately does NOT read the return value of
    // the `write` it was passed to — a stream that calls back synchronously
    // would hit that binding in its temporal dead zone, which is a crash rather
    // than the backpressure handling it looks like.
    const write = (chunk: Buffer): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const flushed = res.write(chunk, (err) => {
          if (err) reject(err)
          else resolve()
        })
        if (!flushed) res.once('drain', resolve)
      })

    const zip = new ZipStreamWriter(write)
    const mtimeMs = deps.now()
    const startedAt = deps.now()
    const manifestTracks: DebugManifestTrack[] = []
    let included = 0
    let missing = 0
    // The plan may already have stopped short of what is marked; carry that
    // reason through so the manifest names ONE cause rather than just a flag.
    let stoppedBecause: DebugBundleManifest['stoppedBecause'] = plan.capped ? 'track-cap' : null

    for (const entry of plan.tracks) {
      if (zip.bytesWritten >= MAX_EXPORT_BYTES) {
        stoppedBecause ??= 'byte-budget'
        deps.logger.warn('debug export stopped — byte budget reached', {
          meta: { budget: MAX_EXPORT_BYTES, written: zip.bytesWritten },
        })
        break
      }
      const dir = debugTrackDir(entry.report.deviceId, entry.report.trackId)
      const deviceId = entry.report.deviceId

      for (const [name, body] of [
        [DEBUG_TRACK_ENTRY, json(entry.track)],
        [DEBUG_ANALYSIS_ENTRY, json(entry.report)],
        [DEBUG_EVENTS_ENTRY, json(entry.events)],
      ] as const) {
        if (!(await zip.add({ name: `${dir}/${name}`, body, mtimeMs })))
          stoppedBecause ??= 'zip-ceiling'
      }

      const mediaIncluded: string[] = []
      const mediaMissing: number[] = []
      for (const media of entry.media) {
        const bytes = await deps.readMedia(media.mediaId)
        if (bytes === null) {
          // Named, with the deviceId: a bundle short one file looks exactly like
          // a track that never captured it, and that is the whole question the
          // operator opened the bundle to answer.
          missing += 1
          mediaMissing.push(media.mediaId)
          deps.logger.warn('debug export skipped a media file — the blob is unreadable', {
            tags: { deviceId },
            meta: { trackId: entry.report.trackId, mediaId: media.mediaId, kind: media.kind },
          })
          continue
        }
        if (!(await zip.add({ name: `${dir}/${media.name}`, body: bytes, mtimeMs }))) {
          stoppedBecause ??= 'zip-ceiling'
          missing += 1
          mediaMissing.push(media.mediaId)
          deps.logger.warn('debug export skipped a media file — the archive is full', {
            tags: { deviceId },
            meta: { trackId: entry.report.trackId, mediaId: media.mediaId, kind: media.kind },
          })
          continue
        }
        included += 1
        mediaIncluded.push(media.name)
        await new Promise((resolve) => setTimeout(resolve, MEDIA_PACING_MS))
      }

      manifestTracks.push({
        trackId: entry.report.trackId,
        deviceId,
        dir,
        className: entry.report.className,
        ...(entry.report.label === undefined ? {} : { label: entry.report.label }),
        firstSeen: entry.report.firstSeen,
        lastSeen: entry.report.lastSeen,
        durationMs: entry.report.durationMs,
        eventCount: entry.report.eventCount,
        findings: entry.report.findings.map((f) => f.code),
        mediaIncluded,
        mediaMissing,
      })
      await new Promise((resolve) => setTimeout(resolve, TRACK_PACING_MS))
    }

    // LAST, and therefore true: every blob has been attempted by now, so the
    // manifest records what the archive carries rather than what the plan hoped
    // for. ZIP is indexed from the central directory, so a trailing entry is as
    // findable as a leading one.
    const manifest: DebugBundleManifest = {
      generatedAt: plan.generatedAt,
      deviceIds: plan.deviceIds,
      trackCount: manifestTracks.length,
      mediaIncluded: included,
      mediaMissing: missing,
      truncated: stoppedBecause !== null,
      stoppedBecause,
      retentionNote: DEBUG_RETENTION_NOTE,
      tracks: manifestTracks,
    }
    await zip.add({ name: DEBUG_MANIFEST_ENTRY, body: json(manifest), mtimeMs })
    await zip.finish()
    await new Promise<void>((resolve) => {
      res.end(resolve)
    })

    deps.logger.info('debug export complete', {
      meta: {
        tracks: manifestTracks.length,
        mediaIncluded: included,
        mediaMissing: missing,
        stoppedBecause,
        bytes: zip.bytesWritten,
        elapsedMs: deps.now() - startedAt,
      },
    })
  }
}
