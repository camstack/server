import type { AddonContext } from '@camstack/types'
import { NcArtifactPlane } from '../../notification-center/artifact-plane.js'
import type { PruneWindows } from '../../notification-center/prune-windows.js'
import type { SummaryMosaicPorts } from '../../notification-center/summary/summary-mosaic.js'
import { fileSummaryMosaic } from '../../notification-center/summary/summary-mosaic.js'
import type { NcSummaryPorts } from '../../notification-center/summary/summary-producer.js'
import type { DetectionSensitivitySettings } from '../detection-sensitivity-settings.js'
import { FrameState } from '../frame/frame-state.js'
import { MediaStore, SUMMARY_MOSAIC_OWNER_KIND } from '../store/media-store.js'
import { resolveSubjectShot } from '../store/media-subject-shot.js'
import type { AnalyticsApi, AnalyticsStores } from './boot-types.js'
import { NO_PUBLICATION } from './boot-types.js'

export interface BuildNotificationPortsDeps {
  readonly resolveDeviceDetectionSensitivitySettings: (
    deviceId: number,
  ) => Promise<DetectionSensitivitySettings>
  readonly frameState: () => FrameState
  readonly pruneWindows: () => Promise<PruneWindows>
  readonly ncArtifactPlane: () => NcArtifactPlane | null
  readonly ctx: () => AddonContext<Record<string, unknown>>
  readonly pinnedFfmpeg: () => () => Promise<string>
}

export class BuildNotificationPortsBase {
  constructor(protected readonly deps: BuildNotificationPortsDeps) {}

  protected async resolveDeviceDetectionSensitivitySettings(
    deviceId: number,
  ): Promise<DetectionSensitivitySettings> {
    return this.deps.resolveDeviceDetectionSensitivitySettings(deviceId)
  }

  protected get frameState(): FrameState {
    return this.deps.frameState()
  }

  protected async pruneWindows(): Promise<PruneWindows> {
    return this.deps.pruneWindows()
  }

  protected get ncArtifactPlane(): NcArtifactPlane | null {
    return this.deps.ncArtifactPlane()
  }

  protected get ctx(): AddonContext<Record<string, unknown>> {
    return this.deps.ctx()
  }

  protected get pinnedFfmpeg(): () => Promise<string> {
    return this.deps.pinnedFfmpeg()
  }

  /**
   * The multi-camera digest producer's ports.
   *
   * Every one reads something this process already owns: the LOCAL track store
   * for the window (no self-cap call, `projection: 'slim'` because the selector
   * reads timestamps, class, zones, importance and the sighting COUNT and
   * nothing else), the LOCAL media store for the index rows and the one blob
   * per tile, and the NC artifact plane for the public link.
   *
   * The count is why `observations` is a stored column rather than
   * `positions.length` derived on read: this selector re-applies the tracker's
   * `minHits` to closed rows, and the slim projection now genuinely declines to
   * READ the trajectory blob instead of reading it and hiding it.
   *
   * The mosaic is filed through the SAME `mediaStore` every event thumbnail
   * goes through — the operator's directive, verbatim: same data structure,
   * same storage location, no second retained store. It is written under
   * `ownerKind: 'mosaic'` with the RULE as its owner id (D480), so it lands
   * beside the cameras' event media (`<deviceId>/events/mosaic/<ruleId>/…`)
   * and its lifetime is the WRITER's per-rule bound (`fileSummaryMosaic`),
   * not a sweeper's guess.
   *
   * The two owner kinds it borrowed before both meant the same thing: a
   * synthetic `summary-<ruleId>-<windowEndMs>` id in a table's namespace that
   * no table has ever held. Under `'event'` the orphan audit could never
   * reach it (675 rows / 271 MiB accumulated on one rule); under `'object'`
   * the per-table probe would have called every one of them an orphan the
   * first time a sweep got that far, which is a delete of already-delivered
   * notification images.
   *
   * It is deliberately NOT owned by a track: a track's media list is a LIVE
   * viewer surface, and a cross-camera mosaic appearing in one track's tiles
   * would be a picture that lies about what it is of.
   */
  buildSummaryPorts(api: AnalyticsApi, stores: AnalyticsStores): NcSummaryPorts {
    return {
      listTracks: async ({ deviceId, sinceMs, untilMs, limit }) => {
        const windowTracks = await stores.trackStore.queryHistorical({
          deviceId,
          since: sinceMs,
          until: untilMs,
          projection: 'slim',
          limit: Math.max(limit, 2_000),
        })
        const { minHits } = await this.resolveDeviceDetectionSensitivitySettings(deviceId)
        return windowTracks.map((t) => ({
          trackId: t.trackId,
          deviceId,
          className: t.className,
          firstSeen: t.firstSeen,
          lastSeen: t.lastSeen,
          zones: [...t.zonesVisited],
          ...(t.importance !== undefined ? { importance: t.importance } : {}),
          ...(t.classes !== undefined && t.classes.length > 0 ? { classes: t.classes } : {}),
          ...(t.closedReason === 'stationary-promotion' ? { stationary: true } : {}),
          confirmed: t.observations !== undefined && t.observations >= minHits,
        }))
      },
      listMediaInfo: async (id) => {
        const rows = await stores.mediaStore.listInfoByOwner('track', id)
        return rows.map((r) => ({
          mediaId: r.mediaId,
          kind: r.kind,
          timestamp: r.timestamp,
          // `sizeBytes` is what makes the ladder's face-template floor real,
          // and it is free — the index row already carries it, no blob is
          // read to get it. A mapping that omitted it would leave the floor
          // inert with nothing to say so.
          sizeBytes: r.sizeBytes,
        }))
      },
      readMedia: async (mediaId) => {
        const file = await stores.mediaStore.getBytesById(mediaId)
        if (file === null) return null
        return file.bytes
      },
      // What each LOCATION looks like, operator-authored — read from the
      // LOCATION itself, beside its icon, not from this addon's settings.
      //
      // It used to live here, as an editable array where the operator retyped
      // the location name by hand and it was matched exactly and
      // case-sensitively. Two authorities for one thing, joined by two
      // different rules: renaming a room in the Locations page carried its
      // icon and left the description on a key no location would ever carry
      // again, in silence. Keyed by the folded label now, like everything else
      // about a location.
      //
      // ONE call per digest, never one per location — D447 is this repo's
      // record of a settings-backed reader asked per key. A failure yields an
      // EMPTY map, and an empty map is the same digest this produced before
      // descriptions existed: the model is told the place NAME. Never a throw
      // that loses the digest over a decoration.
      locationDescriptions: async () => {
        const rows = await api.deviceManager.listLocationDescriptions.query()
        return new Map(rows.map((row) => [row.locationKey, row.description]))
      },
      // The rule itself is `resolveSubjectShot` — a boxed media row first,
      // the snapshot pairing for rows written before the box existed (D510).
      // Only the PORTS are wired here.
      subjectShotFor: (trackId, deviceId, aroundMs) =>
        resolveSubjectShot(
          {
            boxedMedia: (id, device) =>
              stores.mediaStore.listSubjectBoxesByOwner('track', id, device),
            trackSnapshots: async (id) => {
              const track =
                stores.trackStore.getActiveByTrack(id) ??
                (await stores.trackStore.getPersistedByTrackId(id))
              if (track === null || track === undefined) return []
              return track.snapshots.map((snap) => ({
                timestamp: snap.timestamp,
                mediaId: snap.mediaId,
                bbox: snap.position.bbox,
              }))
            },
            frameDims: (device) => this.frameState.lastFrameDimsByDevice.get(device),
          },
          trackId,
          deviceId,
          aroundMs,
        ),
      storeMosaic: async ({ deviceId, ruleId, timestamp, jpeg }) => {
        // Read at CALL time: the window is an operator setting and a value
        // captured at construction would ignore every later Save.
        const windows = await this.pruneWindows()
        return fileSummaryMosaic(this.summaryMosaicPorts(stores.mediaStore), {
          deviceId,
          ruleId,
          timestamp,
          jpeg,
          olderThanMs:
            windows.summaryMosaicMs === null ? null : timestamp - windows.summaryMosaicMs,
        })
      },
      // Read at CALL time, not captured: these ports are built while the centre
      // is being constructed and `serveNcArtifactPlane` may not have run yet.
      publish: async (bytes, mime, meta) =>
        (await this.ncArtifactPlane?.publishIndexed(bytes, mime, meta)) ?? NO_PUBLICATION,
    }
  }

  /**
   * The mosaic writer's three powers, and no more: write one, list what a rule
   * holds, and delete one with its blob CONFIRMED gone.
   *
   * `ownerKind` is not among them on purpose — the owner kind is decided once,
   * here, and `fileSummaryMosaic` has no parameter that could carry a
   * borrowed one (D480).
   */
  summaryMosaicPorts(mediaStore: MediaStore): SummaryMosaicPorts {
    return {
      put: ({ deviceId, ownerId, timestamp, jpeg }) =>
        mediaStore.put({
          deviceId,
          ownerKind: SUMMARY_MOSAIC_OWNER_KIND,
          ownerId,
          // `fullFrame` is the honest kind for a full-resolution clean
          // composite: the enum lives in `packages/types` and a new member
          // would be a framework train for a label.
          kind: 'fullFrame',
          timestamp,
          data: jpeg,
        }),
      listInfo: (ownerId) => mediaStore.listInfoByOwner(SUMMARY_MOSAIC_OWNER_KIND, ownerId),
      deleteConfirmed: (key) => mediaStore.deleteConfirmed(key),
      logger: this.ctx.logger.child('SummaryMosaic'),
    }
  }
}
