import {
  controlCapability,
  DeviceRole,
  errMsg,
  type ControlStatus,
  type DeviceContext,
  type InferNativeProvider,
} from '@camstack/types'
import { MowerDevice as DreameMower } from '@apocaliss92/nodedreame'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'control'

/** HA-style label for a map option: `"<name> (#<id>)"` (name falls back to `Map <id>`). */
function mapLabel(mapId: number, name: string): string {
  return name.length > 0 ? `${name} (#${mapId})` : `Map ${mapId} (#${mapId})`
}

/**
 * Mower "Map" select — a container-level `DeviceType.Control` (select) child that
 * switches the mower's ACTIVE map (HA `select.a1_map`). Options + the current
 * value come from the live `MowerMap.availableMaps` / `currentMapId`; selecting an
 * option calls `setCurrentMap(mapId)` (2:50 o:200) via the verified `control`
 * cap mutation path. Lives at container level (NOT in the image settings) so it
 * is a first-class selectable entity.
 */
export class DreameMowerMapSelectDevice extends DreameChildDevice {
  #inflight = false

  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.SelectControl)
    void this.updateSourceInfo({ id: `${this.dreameDeviceId}:mower-map-select`, system: 'dreame' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    const mower = this.resolveMower()
    if (mower !== null && mower.lastMap === null) void this.#ensureMap(mower)
    else this.#publishSlice()
  }

  private resolveMower(): DreameMower | null {
    const handle = this.resolveHandle()
    return handle instanceof DreameMower ? handle : null
  }

  async #ensureMap(mower: DreameMower): Promise<void> {
    if (this.#inflight) return
    this.#inflight = true
    try {
      await mower.getMap()
    } catch (err) {
      this.ctx.logger.debug('dreame mower map-select: map fetch failed', {
        tags: { deviceId: this.id },
        meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
      })
    } finally {
      this.#inflight = false
      this.#publishSlice()
    }
  }

  #slice(mower: DreameMower): ControlStatus {
    const map = mower.lastMap
    const options = (map?.availableMaps ?? []).map((m) => mapLabel(m.mapId, m.name))
    const current = map?.currentMapId ?? null
    const entry = map?.availableMaps.find((m) => m.mapId === current)
    return {
      kind: 'select',
      value: entry ? mapLabel(entry.mapId, entry.name) : '',
      options,
      lastChangedAt: Date.now(),
    }
  }

  #publishSlice(): void {
    const mower = this.resolveMower()
    if (mower === null) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(mower))
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof controlCapability> = {
      getStatus: async () => {
        const mower = this.resolveMower()
        if (mower === null) {
          return (
            this.runtimeState.getCapState<ControlStatus>(CAP_NAME) ?? {
              kind: 'select',
              value: '',
              options: [],
              lastChangedAt: Date.now(),
            }
          )
        }
        return this.#slice(mower)
      },
      setValue: async ({ control }) => {
        if (control.kind !== 'select') {
          throw new Error(
            `DreameMowerMapSelectDevice: expected a select value (device=${this.dreameDeviceId})`,
          )
        }
        const mower = this.resolveMower()
        if (mower === null) {
          throw new Error(
            `DreameMowerMapSelectDevice: mower handle unavailable (device=${this.dreameDeviceId})`,
          )
        }
        const entry = (mower.lastMap?.availableMaps ?? []).find(
          (m) => mapLabel(m.mapId, m.name) === control.value,
        )
        if (entry === undefined) {
          throw new Error(
            `DreameMowerMapSelectDevice: unknown map "${control.value}" (device=${this.dreameDeviceId})`,
          )
        }
        await mower.setCurrentMap(entry.mapId)
        this.runtimeState.setCapState(CAP_NAME, { ...this.#slice(mower), value: control.value })
      },
    }
    this.ctx.registerNativeCap(controlCapability, provider)
    this.#publishSlice()
  }

  protected override recomputeSlice(): void {
    this.#publishSlice()
  }
}
