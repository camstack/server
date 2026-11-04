/**
 * One running HomeKit bridge: the runtime of a `hap-bridges` record (#422). The addon keeps one
 * of these per ENABLED record. It owns what is per bridge and nothing else: the identity a
 * controller pairs with, the lazy bridge accessory, what the bridge exposes (devices and actions)
 * and the accessories that exist for it right now. Everything shared across bridges (the decode
 * memos, the pinned ffmpeg, the clip store) stays on the addon.
 */
import type { ActionExports } from './action-exports.js'
import type { BridgeHost } from './bridge-host.js'
import type { ExposedConfigEntry, HapBridgeExportsBody } from './hap-export-records.js'
import type { HapBridgeIdentity } from './hap-instance-kinds.js'
import { accessoryUuidFor, type MapperKind } from './mappers/kind.js'
import type { Mapper } from './mappers/types.js'
import type { ExportTargetEntry } from '@camstack/types/node'

export class BridgeInstance {
  /** The devices of this bridge that have a live accessory, by device id. */
  readonly exposed = new Map<string, Mapper>()
  /** Pending rebuild timers per device id: debounce, cleared on detach. */
  readonly pendingRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>()
  actionExports: ActionExports | null = null
  /** Last advertised export fingerprints (the reconcile cache) of a NON-default bridge; the default one persists its own. */
  readonly syncState = new Map<number, ExportTargetEntry>()

  constructor(
    readonly id: string,
    /** The record's name as it was when this runtime started: the bridge's HomeKit label. */
    readonly name: string,
    readonly identity: HapBridgeIdentity,
    readonly bridgeHost: BridgeHost,
    /** What the bridge exposes; written through on every change. */
    public exposure: HapBridgeExportsBody,
  ) {}

  get pincode(): string {
    return this.identity.pincode
  }

  findEntry(deviceId: number): ExposedConfigEntry | null {
    const id = String(deviceId)
    return this.exposure.devices.find((e) => e.deviceId === id) ?? null
  }

  /** The HAP accessory uuid this bridge gives a device (`accessoryUuidFor`, salted per bridge). */
  accessoryUuidOf(kind: MapperKind, deviceId: number): string {
    return accessoryUuidFor(kind, deviceId, this.id)
  }

  /**
   * Every accessory uuid whose pairing state belongs to this bridge: the bridge itself, each live
   * accessory of a device and each exported action. What a Regenerate or a delete must wipe.
   */
  pairingUuids(): readonly string[] {
    const fromDevices = [...this.exposed.values()].flatMap((m) => m.accessories.map((a) => a.UUID))
    return [this.identity.uuid, ...fromDevices, ...(this.actionExports?.accessoryUuids() ?? [])]
  }
}
