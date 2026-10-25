/**
 * Scheduled-timelapse ports the notification centre is built with.
 * Moved out of `pipeline-analytics/index.ts` verbatim (Plan B, boot
 * extraction): only the visibility of the entry point changed. The shared
 * port accessors live on {@link BuildNotificationPortsBase}.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NcTimelapseRenderPorts } from '../../notification-center/index.js'
import { buildTimelapseArtifactPublisher } from '../../notification-center/timelapse/artifact-publish.js'
import {
  execFileCapturingStdout,
  renderTimelapsePreview,
} from '../../notification-center/timelapse/preview-frame.js'
import { renderTimelapseGif } from '../../notification-center/timelapse/preview-gif.js'
import { TIMELAPSE_EXPORT_LIFE_MS } from '../../notification-center/timelapse/timelapse-renderer.js'
import { ourRecordingAvailability } from '../our-recording-availability.js'
import type { AnalyticsApi, AnalyticsStores } from './boot-types.js'
import {
  NO_PUBLICATION,
  TIMELAPSE_EVENT_QUERY_LIMIT,
  TIMELAPSE_TRACK_QUERY_LIMIT,
} from './boot-types.js'
import { BuildNotificationPortsBase } from './build-notification-ports.js'

export class BuildNotificationPorts extends BuildNotificationPortsBase {
  /**
   * The scheduled-timelapse producer's ports.
   *
   * Every one of them is something that already exists: `recording` for the
   * footage index, the LOCAL track store for the history (no self-cap call, and
   * `projection: 'slim'` because the planner reads two timestamps per track and
   * nothing else), `recordingExport` for the render.
   *
   * TWO links, two audiences, and they are not interchangeable:
   *
   *  - `publishArtifact` produces the one a notifier BACKEND fetches. It reads
   *    the finished mp4 once through `recordingExport.readExportBytes` and
   *    republishes it on the NC artifact plane — the same signed, expiring,
   *    public surface a detection rule's still and clip already ride. Bounded
   *    at `RECORDING_EXPORT_MAX_READ_BYTES`; above it there is no attachment
   *    and a log line saying so.
   *  - `resolveDownloadUrl` produces the one the RECIPIENT taps. The export's
   *    own download route is served `access: 'authenticated'`, so it is a
   *    perfectly good `clickUrl` and a useless attachment URL — a backend
   *    fetching it holds no session and gets a 401.
   */
  buildTimelapsePorts(api: AnalyticsApi, stores: AnalyticsStores): NcTimelapseRenderPorts {
    return {
      getAvailability: async ({ deviceId, fromMs, toMs, profile }) => {
        const availability = await ourRecordingAvailability(api, {
          deviceId,
          fromMs,
          toMs,
          ...(profile !== undefined ? { profile } : {}),
        })
        // BOTH fields. `ranges` describes one band; `profilesWithFootage`
        // names them all, and without it the renderer's "cheapest band" rule
        // can only ever choose the preferred one — `high` (D433, D435).
        return {
          ranges: availability.ranges,
          profilesWithFootage: availability.profilesWithFootage,
        }
      },
      listTracks: async ({ deviceId, since, until }) => {
        const tracks = await stores.trackStore.queryHistorical({
          deviceId,
          since,
          until,
          projection: 'slim',
          // EXPLICIT, because the store's default is 50 — a ten-hour night on a
          // busy camera would have planned its dense ranges from the newest 50
          // tracks and, now that the same array is counted, would print "50
          // persone" on a night that held four hundred. A count that
          // under-reports silently is worse than no count.
          limit: TIMELAPSE_TRACK_QUERY_LIMIT,
        })
        // `className` rides along for the per-class counts, `trackId` so the
        // event half of the merge can recognise the SAME subject and not count
        // it twice (see `detection-intervals.ts`).
        return tracks.map((t) => ({
          trackId: t.trackId,
          firstSeen: t.firstSeen,
          lastSeen: t.lastSeen,
          className: t.className,
        }))
      },
      /**
       * The other half of "did anything happen here": the object-event rows.
       *
       * The persisted track store is NOT a complete record of the window. Three
       * gates destroy a track before it is written — the confirmation gate
       * retracting a suspected false birth, stationary promotion dropping a
       * parked object, zero-media suppression cascading a thumbnail-less track
       * away — and on 2026-08-13 they left camera 101 with zero persisted tracks
       * across a ten-hour night that held a person pass at 23:31. These rows
       * survive all three.
       *
       * FULL projection, not slim: `slimObject` drops `trackId`, and without it
       * every event of one subject becomes its own detection. It costs nothing
       * at the store — the row is read whole either way and slim only strips
       * fields afterwards.
       */
      listDetectionEvents: async ({ deviceId, since, until }) => {
        const events = await stores.eventStore.queryObject({
          deviceId,
          since,
          until,
          limit: TIMELAPSE_EVENT_QUERY_LIMIT,
        })
        return events.map((e) => ({
          timestamp: e.timestamp,
          className: e.className,
          ...(e.trackId !== undefined ? { trackId: e.trackId } : {}),
        }))
      },
      // Rebuilt as a literal rather than forwarded: the generated cap proxy
      // takes an index-signature-bearing input, which a readonly interface is
      // not assignable to — and a cast here would be the exact thing the repo
      // forbids.
      // Read per render, so a Save takes effect on the next export rather than
      // on the next addon restart. A configured 0 ("keep forever") cannot be
      // expressed on `recording-export` (`maxLifeMs` is positive-only), so it
      // resolves back to the shipped default instead of a fabricated life.
      exportLifeMs: async () =>
        (await this.pruneWindows()).timelapseExportMs ?? TIMELAPSE_EXPORT_LIFE_MS,
      createExport: (input) =>
        api.recordingExport.createExport.mutate({
          deviceId: input.deviceId,
          profile: input.profile,
          fromMs: input.fromMs,
          toMs: input.toMs,
          options: {
            includeAudio: input.options.includeAudio,
            maxLifeMs: input.options.maxLifeMs,
            deleteAfterDownload: input.options.deleteAfterDownload,
            title: input.options.title,
            timelapse: {
              everyMs: input.options.timelapse.everyMs,
              outputFps: input.options.timelapse.outputFps,
              ...(input.options.timelapse.dense !== undefined
                ? {
                    dense: {
                      everyMs: input.options.timelapse.dense.everyMs,
                      ranges: input.options.timelapse.dense.ranges.map((r) => ({
                        fromSec: r.fromSec,
                        toSec: r.toSec,
                      })),
                    },
                  }
                : {}),
            },
          },
        }),
      getExport: ({ exportId }) => api.recordingExport.getExport.query({ exportId }),
      // How a retry joins the render it already ordered. Scoped to the camera:
      // the row set is per-device history, and the renderer only ever adopts a
      // row for the camera it is rendering.
      listExports: ({ deviceId }) => api.recordingExport.listExports.query({ deviceId }),
      // The plane is read at CALL time, not captured here: these ports are
      // built while the notification centre is being constructed, and
      // `serveNcArtifactPlane` may not have run yet.
      publishArtifact: buildTimelapseArtifactPublisher({
        logger: this.ctx.logger.child('Timelapse'),
        readExportBytes: ({ exportId }) => api.recordingExport.readExportBytes.query({ exportId }),
        publish: async (bytes, mime, meta) =>
          (await this.ncArtifactPlane?.publishIndexed(bytes, mime, meta)) ?? NO_PUBLICATION,
        renderPreview: async ({ mode, ...input }) => {
          const previewPorts = {
            logger: this.ctx.logger.child('Timelapse'),
            run: execFileCapturingStdout,
            writeTemp: async (bytes: Uint8Array) => {
              const file = path.join(os.tmpdir(), `camstack-tl-${randomUUID()}.mp4`)
              await fs.writeFile(file, bytes)
              return file
            },
            removeTemp: (file: string) => fs.rm(file, { force: true }),
            // The node's pinned build (D540). This port used to be absent, so
            // the preview spawned a bare `ffmpeg` from PATH — the host's binary.
            resolveFfmpeg: this.pinnedFfmpeg,
          }
          // A GIF that could not be assembled DEGRADES to the still — the mime
          // answered here is what the bytes ACTUALLY are, never what the rule
          // asked for, because a JPEG published as `image/gif` is a picture the
          // recipient's client refuses to draw.
          if (mode === 'gif') {
            const gif = await renderTimelapseGif(previewPorts, input)
            if (gif !== null) return { bytes: gif, mime: 'image/gif' }
            this.ctx.logger
              .child('Timelapse')
              .warn('timelapse gif unavailable — falling back to the still', {
                tags: { deviceId: input.deviceId },
              })
          }
          const jpeg = await renderTimelapsePreview(previewPorts, input)
          return jpeg === null ? null : { bytes: jpeg, mime: 'image/jpeg' }
        },
      }),
      resolveDownloadUrl: async ({ exportId }) => {
        const plane = this.ncArtifactPlane
        if (plane === null) return null
        const download = await api.recordingExport.getDownloadUrl.query({
          exportId,
        })
        // The provider answers a RELATIVE data-plane path; only the artifact
        // plane knows which host the recipient can reach.
        return plane.resolveExternalUrl(download.url)
      },
      // The post-render pacing check's one measurement: the finished file's own
      // bytes (its mvhd is the only place the delivered frame count lives).
      // Same cap read the publisher uses; the renderer bounds and best-efforts it.
      readExportBytes: ({ exportId }) => api.recordingExport.readExportBytes.query({ exportId }),
    }
  }
}
