/**
 * PlateGalleryProvider — implements the `plate-gallery` system capability.
 *
 * Lists recent reads (with inline crop), groups near-identical reads
 * (clusterByText), searches by text proximity, corrects the OCR text, deletes
 * reads, AND manages VEHICLE identities: named vehicles keyed by license-plate
 * text vicinity (the plate analogue of face identities). Assigning a read to a
 * vehicle enrolls a `vehicle-samples` row, reowns the crop, and propagates the
 * vehicle name as the track/event label — a direct transcription of
 * `FaceGalleryProvider.assignFace`, substituting embeddings with text + score.
 */

import type {
  IPlateGalleryProvider,
  IScopedLogger,
  PipelineAnalyticsPlateGalleryChangedPayload,
  PlateInfo,
  Vehicle,
  VehicleSampleInfo,
} from '@camstack/types'
import { type GalleryMediaRow, toGalleryMediaRow } from './gallery-media-row.js'
import { resolveIncludeCrops } from './include-crops-default.js'
import { applyTrackLabelCandidate } from './pipeline/apply-track-label.js'
import { clusterByText, normalizePlate, plateDistance } from './pipeline/plate-clustering.js'
import type { EventStore } from './store/event-store.js'
import { mediaFileUrl } from './media-file-url.js'
import type { MediaStore } from './store/media-store.js'
import type { Plate, PlateStore } from './store/plate-store.js'
import type { TrackStore } from './store/track-store.js'
import type { VehicleStore } from './store/vehicle-store.js'

/** Attribution of a vehicle name BOUND BY THE OPERATOR in the plate gallery. */
const OPERATOR_PLATE_STEP_ID = 'operator:plate-gallery'

export interface PlateGalleryProviderDeps {
  readonly plateStore: PlateStore
  readonly vehicleStore: VehicleStore
  readonly mediaStore: MediaStore
  readonly trackStore: TrackStore
  readonly eventStore: EventStore
  readonly logger: IScopedLogger
  /** Called after gallery mutations to refresh the plate recognizer. */
  readonly refreshGallery: () => void
  /**
   * Best-effort bus notification fired AFTER assign/unassign/delete store
   * writes succeed. A lost emit only delays the admin-ui live-refresh (D8
   * telemetry semantics), never the mutation itself.
   */
  readonly emitPlateGalleryChanged: (payload: PipelineAnalyticsPlateGalleryChangedPayload) => void
  /**
   * Base URL of the `event-media` data plane, or null when the addon has no
   * data-plane facility. Lazy (a function) because the plane is served AFTER
   * the providers are constructed.
   */
  readonly eventMediaBaseUrl: () => string | null
  /**
   * `/addon/<addonId>/event-media` — the path a media row is addressed under.
   *
   * Not `eventMediaBaseUrl`: that one is null until `dataPlane.serve`
   * succeeds, which is the right question for an OPTIONAL `cropUrl` stamp and
   * the wrong one for a row's only address.
   */
  readonly eventMediaPathPrefix: () => string
}

/** The minimum {@link PlateGalleryProvider.cropUrlFor} needs: the media row a
 *  crop lives in, when there is one (D482). */
interface PlateCropSource {
  readonly mediaId?: number
}

export class PlateGalleryProvider implements IPlateGalleryProvider {
  private readonly plateStore: PlateStore
  private readonly vehicleStore: VehicleStore
  private readonly mediaStore: MediaStore
  private readonly trackStore: TrackStore
  private readonly eventStore: EventStore
  private readonly logger: IScopedLogger
  private readonly refreshGallery: () => void
  private readonly emitPlateGalleryChanged: (
    payload: PipelineAnalyticsPlateGalleryChangedPayload,
  ) => void
  private readonly eventMediaBaseUrl: () => string | null
  private readonly eventMediaPathPrefix: () => string

  constructor(deps: PlateGalleryProviderDeps) {
    this.plateStore = deps.plateStore
    this.vehicleStore = deps.vehicleStore
    this.mediaStore = deps.mediaStore
    this.trackStore = deps.trackStore
    this.eventStore = deps.eventStore
    this.logger = deps.logger
    this.refreshGallery = deps.refreshGallery
    this.emitPlateGalleryChanged = deps.emitPlateGalleryChanged
    this.eventMediaBaseUrl = deps.eventMediaBaseUrl
    this.eventMediaPathPrefix = deps.eventMediaPathPrefix
  }

  /** Best-effort emit — never allowed to fail the mutation it follows. */
  private safeEmitPlateGalleryChanged(payload: PipelineAnalyticsPlateGalleryChangedPayload): void {
    try {
      this.emitPlateGalleryChanged(payload)
    } catch {
      // Best-effort telemetry (D8): a lost/failed emit only delays a UI refresh.
    }
  }

  /**
   * The plane path for a plate crop, or `undefined` when there is no crop to
   * address.
   *
   * `mediaId === undefined` means no media row was ever recorded — never `0`,
   * which would be a request for a rowid that cannot exist (D482).
   */
  private cropUrlFor(plate: PlateCropSource): string | undefined {
    if (plate.mediaId === undefined) return undefined
    const base = this.eventMediaBaseUrl()
    if (base === null) return undefined
    return mediaFileUrl(base, plate.mediaId)
  }

  private async plateCropBase64(plate: Plate): Promise<string | undefined> {
    if (plate.mediaId !== undefined) {
      const m = await this.mediaStore.getById(plate.mediaId)
      if (m) return m.base64
    }
    const media = await this.mediaStore.listByOwner('plate', plate.id)
    return media.length > 0 ? media[0]!.base64 : undefined
  }

  private async toPlateInfo(
    plate: Plate,
    nameMap?: ReadonlyMap<string, string>,
    opts?: { readonly includeCrops?: boolean },
  ): Promise<PlateInfo> {
    const includeCrops = resolveIncludeCrops(opts)
    const base64 = includeCrops ? await this.plateCropBase64(plate) : undefined
    const cropUrl = this.cropUrlFor(plate)
    // `!= null` (not `!== undefined`): the relational plate-store surfaces an
    // unset vehicle as SQL NULL, and PlateInfo's `recognizedVehicleId` is
    // `z.string().optional()` which REJECTS null → output validation would fail.
    const vehicleName =
      plate.recognizedVehicleId != null ? nameMap?.get(plate.recognizedVehicleId) : undefined
    return {
      plateId: plate.id,
      deviceId: plate.deviceId,
      trackId: plate.trackId,
      timestamp: plate.timestamp,
      text: plate.text,
      score: plate.score,
      corrected: plate.corrected,
      assigned: plate.assigned,
      ...(plate.recognizedVehicleId != null
        ? { recognizedVehicleId: plate.recognizedVehicleId }
        : {}),
      ...(vehicleName !== undefined ? { vehicleName } : {}),
      ...(plate.plateBbox !== undefined ? { plateBbox: plate.plateBbox } : {}),
      ...(plate.keyFrameMediaId !== undefined ? { keyFrameMediaId: plate.keyFrameMediaId } : {}),
      ...(base64 !== undefined ? { base64 } : {}),
      ...(cropUrl !== undefined ? { cropUrl } : {}),
    }
  }

  /**
   * Names for the vehicles THESE PLATES reference — not the collection.
   *
   * A page of unassigned reads references none, and then this costs no round
   * trip at all. See `VehicleStore.namesFor`.
   */
  private async vehicleNameMap(
    plates: readonly { readonly recognizedVehicleId?: string }[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.vehicleStore.namesFor(
      plates.flatMap((p) => (p.recognizedVehicleId != null ? [p.recognizedVehicleId] : [])),
    )
  }

  /**
   * `includeCrops` defaults to `true` — the pre-existing behaviour, kept so no
   * caller loses its images. Pass `false` once the caller renders
   * {@link PlateInfo.cropUrl}: measured on the live hub at the 500 rows the
   * Plates view asks for, the inline crops are 879,403 B and 27.7 s, against a
   * few KiB of metadata without them. This is the plate twin of
   * `faceGallery.listRecentFaces`'s option, which shipped first.
   */
  async listPlates(input?: {
    deviceId?: number
    limit?: number
    includeCrops?: boolean
  }): Promise<readonly PlateInfo[]> {
    const rows = await this.plateStore.listRecentPlates({
      ...(input?.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input?.limit !== undefined ? { limit: input.limit } : {}),
    })
    const nameMap = await this.vehicleNameMap(rows)
    const includeCrops = resolveIncludeCrops(input)
    return Promise.all(rows.map((p) => this.toPlateInfo(p, nameMap, { includeCrops })))
  }

  async getPlateByTrack(input: { deviceId: number; trackId: string }): Promise<PlateInfo | null> {
    const plate = await this.plateStore.get(`plate-${input.trackId}`)
    if (!plate || plate.deviceId !== input.deviceId) return null
    const nameMap = await this.vehicleNameMap([plate])
    return this.toPlateInfo(plate, nameMap, { includeCrops: false })
  }

  async getPlateMedia(input: { plateId: string }): Promise<readonly GalleryMediaRow[]> {
    const media = await this.mediaStore.listByOwner('plate', input.plateId)
    return media.map((m) => toGalleryMediaRow(m, this.eventMediaPathPrefix()))
  }

  async searchPlates(input: {
    text: string
    maxDistance?: number
    limit?: number
    includeCrops?: boolean
  }): Promise<readonly PlateInfo[]> {
    const maxDistance = input.maxDistance ?? 1
    const all = await this.plateStore.listAllRecentPlates({})
    const scored = all
      .map((p) => ({ p, dist: plateDistance(input.text, p.text) }))
      .filter((x) => x.dist <= maxDistance)
      .toSorted((a, b) => a.dist - b.dist || b.p.timestamp - a.p.timestamp)
    const limited = input.limit !== undefined ? scored.slice(0, input.limit) : scored
    const nameMap = await this.vehicleNameMap(limited.map((x) => x.p))
    const includeCrops = input.includeCrops ?? true
    return Promise.all(limited.map((x) => this.toPlateInfo(x.p, nameMap, { includeCrops })))
  }

  async suggestPlateClusters(input?: {
    maxDistance?: number
    minClusterSize?: number
    limit?: number
  }): Promise<
    readonly {
      plateIds: readonly string[]
      representativePlateId: string
      representativeText: string
      size: number
      cohesion: number
    }[]
  > {
    const maxDistance = input?.maxDistance ?? 1
    const minClusterSize = input?.minClusterSize ?? 2
    const all = await this.plateStore.listAllRecentPlates({})
    const clusters = clusterByText(
      all.map((p) => ({ id: p.id, text: p.text })),
      maxDistance,
    ).filter((c) => c.size >= minClusterSize)
    return input?.limit !== undefined ? clusters.slice(0, input.limit) : clusters
  }

  async correctPlateText(input: { plateId: string; text: string }): Promise<void> {
    const plate = await this.plateStore.get(input.plateId)
    await this.plateStore.update(input.plateId, {
      text: normalizePlate(input.text),
      corrected: true,
      score: 1,
    })
    this.refreshGallery()
    if (plate !== null) {
      this.safeEmitPlateGalleryChanged({
        deviceId: plate.deviceId,
        plateId: input.plateId,
        kind: 'corrected',
      })
    }
  }

  async deletePlate(input: { plateId: string }): Promise<void> {
    const plate = await this.plateStore.get(input.plateId)
    if (plate?.assigned) await this.unassignPlate({ plateId: input.plateId })
    await this.plateStore.delete(input.plateId)
    await this.mediaStore.deleteForOwner('plate', [input.plateId])
    this.refreshGallery()
    if (plate) {
      this.safeEmitPlateGalleryChanged({
        deviceId: plate.deviceId,
        plateId: input.plateId,
        kind: 'deleted',
      })
    }
  }

  // ── Vehicle CRUD ──────────────────────────────────────────────────────

  async listVehicles(input?: { readonly includeCrops?: boolean }): Promise<readonly Vehicle[]> {
    // Default FALSE — see the face twin in `face-gallery-provider.listIdentities`
    // and the rationale in `include-crops-default.ts`. `coverMediaId` survives
    // on every row, so the plate picture is still one `<img>` away.
    const includeCrops = resolveIncludeCrops(input)
    const rows = await this.vehicleStore.listVehicles()
    const result: Vehicle[] = []
    for (const r of rows) {
      let coverKey = r.coverMediaId ?? undefined
      if (!coverKey) {
        const samples = await this.vehicleStore.listSamples(r.id)
        coverKey = samples.find((s) => s.mediaId)?.mediaId
      }
      // Read the blob only when it will be sent (cheap question first).
      let coverBase64: string | undefined
      if (coverKey && includeCrops) {
        const media = await this.mediaStore.getById(coverKey)
        if (media) coverBase64 = media.base64
      }
      result.push({
        id: r.id,
        name: r.name,
        sampleCount: r.sampleCount,
        ...(coverKey != null ? { coverMediaId: coverKey } : {}),
        ...(coverBase64 !== undefined ? { coverBase64 } : {}),
      })
    }
    return result
  }

  async createVehicle(input: { name: string }): Promise<Vehicle> {
    const raw = await this.vehicleStore.createVehicle({ name: input.name })
    this.refreshGallery()
    return {
      id: raw.id,
      name: raw.name,
      sampleCount: raw.sampleCount,
      ...(raw.coverMediaId !== undefined ? { coverMediaId: raw.coverMediaId } : {}),
    }
  }

  async renameVehicle(input: { id: string; name: string }): Promise<void> {
    await this.vehicleStore.renameVehicle(input.id, input.name)
  }

  async deleteVehicle(input: { id: string }): Promise<void> {
    // Detach assigned plates FIRST (reown crop back to the plate buffer) so no
    // read points at a deleted vehicle + deleted media.
    // The vehicle's OWN rows, through the `recognizedVehicleId` index. This
    // used to list the whole buffer and compare in JS — past the engine's
    // default row cap it detaches the plates that fit and leaves the rest
    // pointing at a vehicle that no longer exists.
    for (const plateId of await this.plateStore.listPlateIdsForVehicle(input.id)) {
      await this.unassignPlate({ plateId })
    }
    await this.mediaStore.deleteForOwner('vehicle', [input.id])
    await this.vehicleStore.deleteVehicle(input.id)
    this.refreshGallery()
  }

  async listVehicleSamples(input: { vehicleId: string }): Promise<readonly VehicleSampleInfo[]> {
    const rows = await this.vehicleStore.listSamples(input.vehicleId)
    const result: VehicleSampleInfo[] = []
    for (const row of rows) {
      let base64: string | undefined
      if (row.mediaId) {
        const media = await this.mediaStore.getById(row.mediaId)
        if (media) base64 = media.base64
      }
      result.push({
        id: row.id,
        text: row.text,
        score: row.score,
        addedAt: row.addedAt,
        ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}),
        ...(base64 !== undefined ? { base64 } : {}),
      })
    }
    return result
  }

  async removeVehicleSample(input: { vehicleId: string; sampleId: string }): Promise<void> {
    const samples = await this.vehicleStore.listSamples(input.vehicleId)
    const sample = samples.find((s) => s.id === input.sampleId)
    if (sample?.mediaId) await this.mediaStore.deleteById(sample.mediaId)
    await this.vehicleStore.removeSample(input.vehicleId, input.sampleId)
  }

  // ── Assign / unassign (transcription of assignFace/unassignFace) ──────

  async assignPlate(input: { plateId: string; vehicleId: string }): Promise<void> {
    const { plateId, vehicleId } = input
    const plate = await this.plateStore.get(plateId)
    if (!plate) throw new Error(`PlateGalleryProvider.assignPlate: plate not found: ${plateId}`)

    // 0. Reassign case — remove the prior sample + clear stale mediaId first.
    if (plate.assignedSampleId !== undefined && plate.recognizedVehicleId !== undefined) {
      await this.removeVehicleSample({
        vehicleId: plate.recognizedVehicleId,
        sampleId: plate.assignedSampleId,
      })
      await this.plateStore.clearAssignment(plateId)
      // Clear the stale reference (its blob was deleted above) so the reown
      // below never tries to move a resource that is gone. Mirrors
      // FaceGalleryProvider. `null` clears the column; the patch type says so,
      // where the call site used to say `null via an unsafe cast to string` (D482).
      await this.plateStore.update(plateId, { mediaId: null })
    }
    const current = await this.plateStore.get(plateId)
    if (!current) throw new Error(`PlateGalleryProvider.assignPlate: plate disappeared: ${plateId}`)

    // 1. Reown the crop plate → vehicle.
    let newMediaId: number | undefined
    if (current.mediaId) {
      newMediaId = await this.mediaStore.reown({
        fromOwnerKind: 'plate',
        fromOwnerId: plateId,
        toOwnerKind: 'vehicle',
        toOwnerId: vehicleId,
        mediaId: current.mediaId,
      })
      await this.plateStore.update(plateId, { mediaId: newMediaId })
    }

    // 2. Enroll the sample, mark assigned; roll back the reown on failure.
    let sampleId: string
    try {
      const sample = await this.vehicleStore.addSample({
        vehicleId,
        text: current.text,
        score: current.score,
        sourcePlateId: plateId,
        ...(newMediaId !== undefined ? { mediaId: newMediaId } : {}),
        ...(current.deviceId !== undefined ? { deviceId: current.deviceId } : {}),
      })
      sampleId = sample.id
      await this.plateStore.markAssigned(plateId, vehicleId, sampleId)
    } catch (err) {
      if (newMediaId !== undefined) {
        try {
          await this.mediaStore.reown({
            fromOwnerKind: 'vehicle',
            fromOwnerId: vehicleId,
            toOwnerKind: 'plate',
            toOwnerId: plateId,
            mediaId: newMediaId,
          })
        } catch {
          /* best-effort rollback */
        }
      }
      throw err
    }

    // 3. Propagate the vehicle name as the track/event label (OVERWRITES any raw
    //    OCR label applied at ingest — this is the retroactive/manual case).
    const vehicle = (await this.vehicleStore.listVehicles()).find((v) => v.id === vehicleId)
    if (vehicle?.name !== undefined) {
      // TIER 2 with operator authority — the named vehicle is the instance, and
      // it deliberately replaces the raw OCR read applied at ingest (this is
      // the retroactive/manual case, and the operator outranks the OCR).
      await applyTrackLabelCandidate(
        { trackStore: this.trackStore, eventStore: this.eventStore, logger: this.logger },
        current.deviceId,
        current.trackId,
        {
          text: vehicle.name,
          tier: 2,
          score: 1,
          stepId: OPERATOR_PLATE_STEP_ID,
          decidedAt: Date.now(),
          operatorAuthority: true,
          // The vehicle id, for the same reason a face carries its identity id:
          // a rule names the row, not the renameable word on it.
          identityId: vehicle.id,
        },
      )
    }

    // 4. Refresh gallery, then best-effort emit AFTER all writes succeed.
    this.refreshGallery()
    this.safeEmitPlateGalleryChanged({ deviceId: current.deviceId, plateId, kind: 'assigned' })
  }

  async unassignPlate(input: { plateId: string }): Promise<void> {
    const { plateId } = input
    const plate = await this.plateStore.get(plateId)
    if (!plate) throw new Error(`PlateGalleryProvider.unassignPlate: plate not found: ${plateId}`)
    const owningVehicleId = plate.recognizedVehicleId

    if (plate.mediaId && owningVehicleId !== undefined) {
      try {
        const restoredMediaId = await this.mediaStore.reown({
          fromOwnerKind: 'vehicle',
          fromOwnerId: owningVehicleId,
          toOwnerKind: 'plate',
          toOwnerId: plateId,
          mediaId: plate.mediaId,
        })
        await this.plateStore.update(plateId, { mediaId: restoredMediaId })
      } catch {
        /* media missing / already moved — still unassign below */
      }
    }
    if (plate.assignedSampleId !== undefined && owningVehicleId !== undefined) {
      await this.vehicleStore.removeSample(owningVehicleId, plate.assignedSampleId)
    }
    await this.plateStore.clearAssignment(plateId)
    await this.eventStore.clearLabelForTrack(plate.trackId, 2)
    await this.trackStore.clearLabel(plate.trackId, 2)
    this.refreshGallery()
    this.safeEmitPlateGalleryChanged({ deviceId: plate.deviceId, plateId, kind: 'unassigned' })
  }

  async assignPlates(input: {
    plateIds: readonly string[]
    vehicleId: string
  }): Promise<{ assigned: number; failed: readonly string[] }> {
    let assigned = 0
    const failed: string[] = []
    for (const plateId of input.plateIds) {
      try {
        await this.assignPlate({ plateId, vehicleId: input.vehicleId })
        assigned += 1
      } catch {
        failed.push(plateId)
      }
    }
    return { assigned, failed }
  }

  async unassignPlates(input: {
    plateIds: readonly string[]
  }): Promise<{ unassigned: number; failed: readonly string[] }> {
    let unassigned = 0
    const failed: string[] = []
    for (const plateId of input.plateIds) {
      try {
        await this.unassignPlate({ plateId })
        unassigned += 1
      } catch {
        failed.push(plateId)
      }
    }
    return { unassigned, failed }
  }
}
