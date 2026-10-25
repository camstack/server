/**
 * `zones-provider.ts` — implements `zonesCapability` for the orchestrator.
 *
 * Per-camera CRUD over polygon detection zones. Persists to the
 * orchestrator's per-device settings store under the `zones` key and
 * mirrors the catalogue into the device-state `zones` slice via
 * `api.deviceState.setCapSlice`. Downstream consumers (motion-wasm,
 * pipeline-executor, analytics, admin UI) read the live state with
 * the canonical `dev.state.zones.onChanged` channel.
 *
 * ── THIS PROVIDER OWNS THE MIRROR FOR ITS WHOLE LIFETIME ──────────
 *
 * The mirror used to be written in exactly ONE place: `persist`, i.e.
 * only when an operator mutates a zone. Nothing seeded it at startup,
 * so a camera whose runtime-state row had never been written (or had
 * been reset) had no `zones` slice at all, and every mirror-only
 * consumer concluded "this camera has no zones" — forever, because no
 * mutation was coming. Live cost (camera 102 'Parking',
 * 2026-08-12): `zones.listZones {102}` returned 'Parking pat'
 * while `deviceState.getCapSlice {102,'zones'}` returned `null`;
 * occupancy dropped all three parked cars into `unzoned`, its zone
 * rule could never fire, and the admin Zones tab — which reads the
 * same mirror — showed "No zones yet".
 *
 * So the mirror is reconciled against the durable catalogue on the
 * READ path too ({@link ZonesProvider.hydrateMirror}), and the boot
 * sweep in `zone-mirror-hydration.ts` walks every camera once at
 * startup. That is deliberately an RPC read, never an event replay:
 * events are lossy telemetry and a slice change that was dropped is
 * never re-sent (D8).
 *
 * Two rules the hydration path must keep (D49):
 *   - a durable read that FAILED changes nothing — it must never be
 *     mirrored, and must not be cached as "this camera has no zones";
 *   - hydration is a reconcile, not a mutation: `onZonesChanged` is
 *     NOT fired, so nothing downstream re-dispatches on a boot read.
 *
 * Onboard / firmware-reported zones are out of scope for now — every
 * zone is operator-drawn. The provider keeps the surface symmetric:
 * `addZone` rejects id collisions, `updateZone` requires an existing
 * id, `removeZone` is idempotent.
 */

import { z } from 'zod'
import {
  type IZonesProvider,
  type Zone,
  ZoneSchema,
  type IScopedLogger,
  type DeviceProxy,
  type DurableState,
  createDurableState,
} from '@camstack/types'

/**
 * Settings + DeviceProxy surface required by the zones provider. Narrow
 * subset of `AddonContext` so the provider is straightforward to test
 * in isolation (the spec passes a fake settings object + a thin
 * fetchDevice stub).
 */
export interface ZonesProviderContext {
  readonly logger: IScopedLogger
  readonly settings: {
    readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
    writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
  }
  /**
   * Per-device facade — same shape as `AddonContext.fetchDevice`. The
   * provider uses it to push the canonical `device-state.setCapSlice`
   * write through the codegen DeviceProxy (which auto-injects deviceId
   * and routes through the cap-router → bridge proxy when device-state
   * lives in another worker).
   */
  readonly fetchDevice: (deviceId: number) => Promise<DeviceProxy>
  /**
   * Optional change hook fired after every successful persist. Used by
   * the orchestrator to re-dispatch the runner camera config whenever
   * zones change so the runner-side zone filters refresh without
   * waiting for the next attach. Fired with the new zone list (already
   * persisted + slice-mirrored).
   */
  readonly onZonesChanged?: (deviceId: number, zones: readonly Zone[]) => void
}

const ZONES_STORE_KEY = 'zones'
const ZONES_CAP_NAME = 'zones'

const ZonesArraySchema = z.array(ZoneSchema)

/**
 * What one hydration attempt did. Reported (not thrown) so the boot sweep can
 * count outcomes and say, per camera, that a mirror was ABSENT — the single
 * line whose absence made 102 take weeks to find.
 *
 *  - `written` — the mirror now carries the durable catalogue.
 *  - `unchanged` — this process already mirrored exactly this catalogue.
 *  - `unreadable` — the durable read failed; the mirror was left untouched.
 *  - `write-failed` — the durable read succeeded, the slice write did not.
 *    Re-attempted on the next read of this device.
 */
export type ZoneMirrorHydration = 'written' | 'unchanged' | 'unreadable' | 'write-failed'

/** A durable catalogue read, with "could not be read" kept distinguishable
 *  from "read fine, and it says none" — the whole point of D49. */
interface ZoneCatalogueRead {
  readonly ok: boolean
  readonly zones: readonly Zone[]
}

/** Identity of a mirrored catalogue — cheap enough to compare on every read,
 *  and it changes whenever anything an operator can see changes. */
function fingerprintZones(zones: readonly Zone[]): string {
  return JSON.stringify(zones)
}

export class ZonesProvider implements IZonesProvider {
  /** Per-device cache. Hydrated lazily on first read for a device. */
  private readonly cache = new Map<number, readonly Zone[]>()
  /**
   * Per-device durable handle over the `zones` store key. The WHOLE
   * validated zone array round-trips on every read/write so no field can
   * be dropped on persist. Built lazily + memoised per device.
   */
  private readonly stateByDevice = new Map<number, DurableState<readonly Zone[]>>()
  /**
   * Per-device fingerprint of the catalogue this process last successfully
   * wrote to the mirror. Absent ⇒ this process has never mirrored the device,
   * so the next read hydrates; a write that FAILED leaves it absent, which is
   * what makes the retry happen on the next read rather than never.
   */
  private readonly mirroredFingerprint = new Map<number, string>()
  /** Devices already reported as unmirrorable — keeps the warn to one per
   *  episode instead of one per read. */
  private readonly reportedMirrorFailure = new Set<number>()

  constructor(private readonly ctx: ZonesProviderContext) {}

  /** Lazily build (and memoise) the durable `zones` handle for a device. */
  private zonesState(deviceId: number): DurableState<readonly Zone[]> {
    let handle = this.stateByDevice.get(deviceId)
    if (!handle) {
      handle = createDurableState<readonly Zone[]>({
        key: ZONES_STORE_KEY,
        schema: ZonesArraySchema,
        fallback: [],
        read: () => this.ctx.settings.readDeviceStore(deviceId),
        write: (patch) => this.ctx.settings.writeDeviceStore(deviceId, patch),
        onParseError: (key, error) =>
          this.ctx.logger.warn('zones store entry failed to parse — resetting', {
            tags: { deviceId },
            meta: { key, error: error instanceof Error ? error.message : String(error) },
          }),
      })
      this.stateByDevice.set(deviceId, handle)
    }
    return handle
  }

  // ── Cap surface ───────────────────────────────────────────────────

  /**
   * The device's catalogue — and, on the way past, the one place a mirror-only
   * consumer's boot blindness is cured: every authoritative read reconciles the
   * device-state slice against what it just read.
   */
  async listZones({ deviceId }: { deviceId: number }): Promise<readonly Zone[]> {
    const read = await this.readCatalogue(deviceId)
    if (read.ok) await this.ensureMirror(deviceId, read.zones)
    return read.zones
  }

  async addZone({ deviceId, zone }: { deviceId: number; zone: Zone }): Promise<void> {
    const existing = await this.readForMutation(deviceId)
    if (existing.some((entry) => entry.id === zone.id)) {
      throw new Error(`zones.addZone: id ${zone.id} already exists`)
    }
    await this.persist(deviceId, [...existing, zone])
  }

  async updateZone({ deviceId, zone }: { deviceId: number; zone: Zone }): Promise<void> {
    const existing = await this.readForMutation(deviceId)
    if (!existing.some((entry) => entry.id === zone.id)) {
      throw new Error(`zones.updateZone: id ${zone.id} not found`)
    }
    const next = existing.map((entry) => (entry.id === zone.id ? zone : entry))
    await this.persist(deviceId, next)
  }

  async removeZone({ deviceId, zoneId }: { deviceId: number; zoneId: string }): Promise<void> {
    const existing = await this.readForMutation(deviceId)
    if (!existing.some((entry) => entry.id === zoneId)) {
      // Idempotent — deleting a missing zone is a no-op.
      return
    }
    await this.persist(
      deviceId,
      existing.filter((entry) => entry.id !== zoneId),
    )
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Reconcile ONE device's mirror against the durable catalogue. The boot
   * sweep (`zone-mirror-hydration.ts`) calls this for every camera so a
   * mirror-only consumer never starts blind; `listZones` calls it too, so a
   * camera adopted after boot is covered by its first read.
   *
   * Never throws — a hydration that cannot happen is reported, and reported
   * once (see {@link ZoneMirrorHydration}).
   */
  async hydrateMirror(deviceId: number): Promise<ZoneMirrorHydration> {
    const read = await this.readCatalogue(deviceId)
    // D49: a read that fails changes nothing. An unreadable store is NOT the
    // same answer as "this camera has no zones", and writing `[]` here would
    // erase a good mirror on one blip.
    if (!read.ok) return 'unreadable'
    return this.ensureMirror(deviceId, read.zones)
  }

  /**
   * Drop a device's cache entry. Called when the device is removed so
   * the next attach starts from a fresh disk read.
   */
  forgetDevice(deviceId: number): void {
    this.cache.delete(deviceId)
    this.stateByDevice.delete(deviceId)
    // The mirror is per-device state keyed by the same id: a future device
    // reusing this id must be hydrated from ITS catalogue, not skipped because
    // this process once mirrored the previous tenant's.
    this.mirroredFingerprint.delete(deviceId)
    this.reportedMirrorFailure.delete(deviceId)
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * The catalogue for a mutation. A mutation is read-modify-write over the
   * WHOLE array, so proceeding from a failed read would persist the operator's
   * zones away — refuse instead.
   */
  private async readForMutation(deviceId: number): Promise<readonly Zone[]> {
    const read = await this.readCatalogue(deviceId)
    if (!read.ok) {
      throw new Error(`zones: catalogue unreadable for device ${deviceId} — refusing to write`)
    }
    return read.zones
  }

  /**
   * Read the durable catalogue, cached per device. A FAILED read is neither
   * cached nor reported as `[]` — the caller decides what an unknown answer
   * means for it.
   */
  private async readCatalogue(deviceId: number): Promise<ZoneCatalogueRead> {
    const cached = this.cache.get(deviceId)
    if (cached) return { ok: true, zones: cached }
    let zones: readonly Zone[]
    try {
      // `get()` validates the whole blob and falls back to `[]` on a
      // missing / corrupt entry (logging via `onParseError`) — never throws.
      zones = await this.zonesState(deviceId).get()
    } catch (err: unknown) {
      this.ctx.logger.warn('zones store read failed — catalogue UNKNOWN for this device', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return { ok: false, zones: [] }
    }
    this.cache.set(deviceId, zones)
    return { ok: true, zones }
  }

  /**
   * Make the device-state mirror agree with `zones`. Idempotent per process
   * via the fingerprint; the hub itself also no-ops an identical
   * `setCapSlice`, so this is belt-and-braces against needless RPCs, not
   * against needless writes.
   */
  private async ensureMirror(
    deviceId: number,
    zones: readonly Zone[],
  ): Promise<ZoneMirrorHydration> {
    const fingerprint = fingerprintZones(zones)
    if (this.mirroredFingerprint.get(deviceId) === fingerprint) return 'unchanged'
    try {
      await this.writeMirror(deviceId, zones)
    } catch (err: unknown) {
      if (!this.reportedMirrorFailure.has(deviceId)) {
        this.reportedMirrorFailure.add(deviceId)
        // A consumer that reads only the mirror is BLIND until this lands, and
        // a blind consumer reports "no zones" rather than an error — so this
        // branch says so, per camera, instead of dropping the work in silence.
        this.ctx.logger.warn(
          'zones mirror write failed — mirror-only consumers see NO zones for this camera until it lands',
          {
            tags: { deviceId },
            meta: { zones: zones.length, error: err instanceof Error ? err.message : String(err) },
          },
        )
      }
      return 'write-failed'
    }
    const first = !this.mirroredFingerprint.has(deviceId)
    this.mirroredFingerprint.set(deviceId, fingerprint)
    this.reportedMirrorFailure.delete(deviceId)
    if (first) {
      this.ctx.logger.info('zones mirror hydrated from the durable catalogue', {
        tags: { deviceId },
        meta: { zones: zones.length },
      })
    }
    return 'written'
  }

  private async writeMirror(deviceId: number, zones: readonly Zone[]): Promise<void> {
    const dev = await this.ctx.fetchDevice(deviceId)
    await dev.deviceState.setCapSlice({
      capName: ZONES_CAP_NAME,
      slice: { zones },
    })
  }

  private async persist(deviceId: number, zones: readonly Zone[]): Promise<void> {
    this.cache.set(deviceId, zones)
    await this.zonesState(deviceId).set(zones)
    await this.writeMirror(deviceId, zones)
    this.mirroredFingerprint.set(deviceId, fingerprintZones(zones))
    this.reportedMirrorFailure.delete(deviceId)
    this.ctx.onZonesChanged?.(deviceId, zones)
  }
}
