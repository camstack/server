/**
 * VehicleStore — per-vehicle identity registry for license-plate recognition.
 *
 * Two SQL-backed collections (parallel to IdentityStore, text-not-embedding):
 *   - pipeline-analytics:vehicles         — named vehicle records
 *   - pipeline-analytics:vehicle-samples  — enrolled plate reads (text + score)
 *
 * A plate is self-labeling (the OCR text IS the key), so a sample carries
 * `text` + `score` instead of an embedding + modelId + dim — no model-version
 * gate is needed. deleteVehicle cascades: removes all sample rows first.
 */

import { randomUUID } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'
import type { EventLedgerCollection } from './event-ledger-collection.js'

/**
 * @durable class=config owner=pipeline-analytics
 *   write="one row per vehicle the OPERATOR creates by name. Updated on rename and
 *     on every sample add or remove (sampleCount, coverMediaId). The plate mirror
 *     of identities — nothing in the pipeline ever creates one."
 *   retention="none — no sweep and no cap touch this table. A row goes only on an
 *     explicit deleteVehicle, which removes its samples first. Bounded solely by
 *     how many vehicles the operator enrols."
 */
export { VEHICLES_COLLECTION, VEHICLE_SAMPLES_COLLECTION } from './pa-collection-names.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per plate read the operator ENROLS onto a vehicle — the
 *     normalised OCR text plus its score and the plate row it came from. A plate is
 *     self-labelling, so this carries text rather than an embedding and needs no
 *     model-version gate. loadGallery reads this table into the matching gallery."
 *   retention="none, by explicit exemption — the plate mirror of identity-samples:
 *     RETENTION_EXEMPT_FAMILIES lists the whole table and the classification
 *     registry marks it never-orphaned. Rows go only on removeSample or
 *     deleteVehicle. Bounded solely by operator enrolment."
 */

export const VEHICLE_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'name', type: 'TEXT' as const, notNull: true },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'sampleCount', type: 'INTEGER' as const, notNull: true },
  { name: 'coverMediaId', type: 'INTEGER' as const },
] as const

export const SAMPLE_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'vehicleId', type: 'TEXT' as const, notNull: true },
  { name: 'text', type: 'TEXT' as const, notNull: true },
  { name: 'score', type: 'REAL' as const, notNull: true },
  { name: 'sourcePlateId', type: 'TEXT' as const },
  { name: 'mediaId', type: 'INTEGER' as const },
  { name: 'deviceId', type: 'INTEGER' as const },
  { name: 'addedAt', type: 'INTEGER' as const, notNull: true },
] as const

export interface Vehicle {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly sampleCount: number
  readonly coverMediaId?: number
}

export interface VehicleSample {
  readonly id: string
  readonly vehicleId: string
  readonly text: string
  readonly score: number
  readonly sourcePlateId?: string
  readonly mediaId?: number
  readonly deviceId?: number
  readonly addedAt: number
}

/** One enrolled plate sample in the in-memory matching gallery. */
export interface PlateGallerySample {
  readonly vehicleId: string
  readonly text: string
}

export interface VehicleStoreDeps {
  readonly logger: IScopedLogger
  readonly vehicleLedger: EventLedgerCollection
  readonly sampleLedger: EventLedgerCollection
}

export interface AddSampleInput {
  readonly vehicleId: string
  readonly text: string
  readonly score: number
  readonly sourcePlateId?: string
  readonly mediaId?: number
  readonly deviceId?: number
}

export type VehicleSampleListItem = Pick<
  VehicleSample,
  'id' | 'text' | 'score' | 'mediaId' | 'addedAt' | 'deviceId'
>

export class VehicleStore {
  private readonly logger: IScopedLogger
  private readonly vehicleLedger: EventLedgerCollection
  private readonly sampleLedger: EventLedgerCollection

  constructor(deps: VehicleStoreDeps) {
    this.logger = deps.logger
    this.vehicleLedger = deps.vehicleLedger
    this.sampleLedger = deps.sampleLedger
  }

  async createVehicle(input: { readonly name: string }): Promise<Vehicle> {
    const now = Date.now()
    const vehicle: Vehicle = {
      id: randomUUID(),
      name: input.name,
      createdAt: now,
      updatedAt: now,
      sampleCount: 0,
    }
    const { id, ...rest } = vehicle
    await this.vehicleLedger.upsertRow(id, rest as Record<string, unknown>)
    return vehicle
  }

  async renameVehicle(id: string, name: string): Promise<void> {
    await this.vehicleLedger.update(id, { name, updatedAt: Date.now() })
  }

  async deleteVehicle(id: string): Promise<void> {
    const samples = await this.sampleLedger.query({ where: { vehicleId: id } })
    for (const s of samples) {
      try {
        await this.sampleLedger.deleteKey(s.id)
      } catch (err) {
        this.logger.warn('deleteVehicle sample delete failed', {
          meta: { vehicleId: id, sampleId: s.id, error: String(err) },
        })
      }
    }
    await this.vehicleLedger.deleteKey(id)
  }

  /**
   * `vehicleId → name` for exactly the vehicles asked about — the plate twin of
   * `IdentityStore.namesFor`, and it exists for the same reason.
   *
   * The decorating half of a plate page needs a NAME per referenced vehicle,
   * and it got it by reading the whole `vehicles` collection: unbounded,
   * unprojected, on every 30 s poll of `plateGallery.listPlates` and again on
   * every `getPlateByTrack` and `searchPlates`. The live table holds **0 rows**
   * — the bytes were never the point. The shape was: a question proportional to
   * a collection, on a timer, to decorate a page.
   *
   * An empty request costs no round trip: `whereIn` over an empty list matches
   * nothing, so asking would be an RPC to be told what the caller knew.
   */
  async namesFor(vehicleIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(vehicleIds)]
    if (ids.length === 0) return new Map()
    const rows = await this.vehicleLedger.query({ whereIn: { id: ids }, limit: ids.length }, [
      'name',
    ])
    const names = new Map<string, string>()
    for (const r of rows) {
      const name = r.data['name']
      if (typeof name === 'string') names.set(r.id, name)
    }
    return names
  }

  async listVehicles(): Promise<readonly Vehicle[]> {
    const rows = await this.vehicleLedger.query({
      orderBy: { field: 'createdAt', direction: 'asc' },
    })
    return rows.map((r) => {
      // Normalize SQL NULL → undefined: the Vehicle output shape's optional
      // number rejects null, so a raw spread of an unset coverMediaId leaks null.
      const data = r.data as Omit<Vehicle, 'id'> & { coverMediaId?: number | null }
      return { id: r.id, ...data, coverMediaId: data.coverMediaId ?? undefined }
    })
  }

  async addSample(input: AddSampleInput): Promise<VehicleSample> {
    const sample: VehicleSample = {
      id: randomUUID(),
      vehicleId: input.vehicleId,
      text: input.text,
      score: input.score,
      ...(input.sourcePlateId !== undefined ? { sourcePlateId: input.sourcePlateId } : {}),
      ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      addedAt: Date.now(),
    }
    const { id, ...rest } = sample
    await this.sampleLedger.upsertRow(id, rest as Record<string, unknown>)
    const vehicle = (await this.listVehicles()).find((v) => v.id === input.vehicleId)
    if (vehicle) {
      const patch: Record<string, unknown> = {
        sampleCount: vehicle.sampleCount + 1,
        updatedAt: Date.now(),
      }
      // `== null` (not `=== undefined`): a fresh vehicle stores coverMediaId as SQL NULL.
      if (vehicle.coverMediaId == null && input.mediaId !== undefined) {
        patch['coverMediaId'] = input.mediaId
      }
      await this.vehicleLedger.update(input.vehicleId, patch)
    }
    return sample
  }

  async listSamples(vehicleId: string): Promise<readonly VehicleSampleListItem[]> {
    const rows = await this.sampleLedger.query({
      where: { vehicleId },
      orderBy: { field: 'addedAt', direction: 'asc' },
    })
    return rows.map((r) => {
      const d = r.data as Partial<VehicleSample>
      return {
        id: r.id,
        text: String(d.text ?? ''),
        score: Number(d.score ?? 0),
        addedAt: Number(d.addedAt ?? 0),
        ...(d.mediaId != null ? { mediaId: d.mediaId } : {}),
        ...(d.deviceId != null ? { deviceId: d.deviceId } : {}),
      }
    })
  }

  async removeSample(vehicleId: string, sampleId: string): Promise<void> {
    await this.sampleLedger.deleteKey(sampleId)
    const vehicle = (await this.listVehicles()).find((v) => v.id === vehicleId)
    if (vehicle) {
      await this.vehicleLedger.update(vehicleId, {
        sampleCount: Math.max(0, vehicle.sampleCount - 1),
        updatedAt: Date.now(),
      })
    }
  }

  async loadGallery(): Promise<readonly PlateGallerySample[]> {
    const rows = await this.sampleLedger.query({})
    const gallery: PlateGallerySample[] = []
    for (const r of rows) {
      const d = r.data as Partial<VehicleSample>
      if (typeof d.text !== 'string' || typeof d.vehicleId !== 'string') continue
      gallery.push({ vehicleId: d.vehicleId, text: d.text })
    }
    return gallery
  }
}
