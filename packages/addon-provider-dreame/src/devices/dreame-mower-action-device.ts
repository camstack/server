import {
  controlCapability,
  DeviceRole,
  errMsg,
  type ControlStatus,
  type DeviceContext,
  type InferNativeProvider,
} from '@camstack/types'
import { MowerDevice as DreameMower, type MowerMap } from '@apocaliss92/nodedreame'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'control'

/** The label shown for the "mow the whole current map" option. */
const ALL_AREA_LABEL = 'All area'

/** One actionable mowing target: its display label + the command that runs it. */
interface MowerActionOption {
  readonly label: string
  readonly run: (mower: DreameMower) => Promise<unknown>
}

/**
 * Mower "Mow" action select — a single `DeviceType.Control` (select) child that
 * collapses HA's 5 interdependent map/zone/edge/spot/mowing-action selects into
 * ONE actionable list. The options are built dynamically from the live mower's
 * last-fetched {@link MowerMap} (all-area + one per zone / edge / spot, gated on
 * the model's targeted-mowing capabilities); selecting an option EXECUTES that
 * mow target immediately (no hidden compose-then-start state).
 *
 * The map is shared with the mower map child via the one live `MowerDevice`
 * handle, so the option list reflects the same zones the map renders. On activate
 * the map is fetched once (best-effort) to populate the options.
 */
export class DreameMowerActionDevice extends DreameChildDevice {
  /** ms-epoch the slice value last changed (last action fired). */
  #value = ''
  /** Single-flight guard for the map fetch that seeds the option list. */
  #inflight = false

  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.SelectControl)
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:mower-action`,
      system: 'dreame',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // Seed the option list: the targets come from the saved map, which is
    // cloud-stored and readable while docked. Best-effort — a model with no map
    // just exposes "All area".
    const mower = this.resolveMower()
    if (mower !== null && mower.lastMap === null) void this.#ensureMap(mower)
    else this.#publishSlice()
  }

  /** Narrow the generic handle to the library's typed {@link DreameMower}, or null. */
  private resolveMower(): DreameMower | null {
    const handle = this.resolveHandle()
    return handle instanceof DreameMower ? handle : null
  }

  /** Best-effort: fetch the map once so the option list is populated, then publish. */
  async #ensureMap(mower: DreameMower): Promise<void> {
    if (this.#inflight) return
    this.#inflight = true
    try {
      await mower.getMap()
    } catch (err) {
      this.ctx.logger.debug('dreame mower action: map fetch failed (asleep?)', {
        tags: { deviceId: this.id },
        meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
      })
    } finally {
      this.#inflight = false
      this.#publishSlice()
    }
  }

  /** Build the actionable target options from the live map + model capabilities. */
  #options(mower: DreameMower): readonly MowerActionOption[] {
    const caps = mower.mowerCapabilities
    const map: MowerMap | null = mower.lastMap
    const options: MowerActionOption[] = []

    if (caps.canMowAllArea) {
      options.push({
        label: ALL_AREA_LABEL,
        run: (m) => m.startMowingAllArea(map?.currentMapId ?? map?.mapId ?? 0),
      })
    }
    if (map === null) return options

    if (caps.canMowZones) {
      for (const zone of map.zones) {
        const id = zone.zoneId
        options.push({
          label: zone.name.length > 0 ? zone.name : `Zone ${id}`,
          run: (m) => m.startMowingZones([id]),
        })
      }
    }
    if (caps.canMowEdges) {
      for (const contour of map.contours) {
        const zoneId = contour.contourId[0] ?? 0
        const zone = map.zones.find((z) => z.zoneId === zoneId)
        const zoneName = zone && zone.name.length > 0 ? zone.name : `Zone ${zoneId}`
        options.push({
          label: `Edge ${zoneName}`,
          run: (m) => m.startMowingEdges([[...contour.contourId]]),
        })
      }
    }
    if (caps.canMowSpots) {
      for (const spot of map.spotAreas) {
        const id = spot.areaId
        options.push({
          label: `Spot ${spot.name.length > 0 ? spot.name : id}`,
          run: (m) => m.startMowingSpots([id]),
        })
      }
    }
    return options
  }

  #slice(mower: DreameMower): ControlStatus {
    return {
      kind: 'select',
      value: this.#value,
      options: this.#options(mower).map((o) => o.label),
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
              value: this.#value,
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
            `DreameMowerActionDevice: expected a select value (device=${this.dreameDeviceId})`,
          )
        }
        const mower = this.resolveMower()
        if (mower === null) {
          throw new Error(
            `DreameMowerActionDevice: mower handle unavailable (device=${this.dreameDeviceId})`,
          )
        }
        const option = this.#options(mower).find((o) => o.label === control.value)
        if (option === undefined) {
          throw new Error(
            `DreameMowerActionDevice: unknown mow target "${control.value}" (device=${this.dreameDeviceId})`,
          )
        }
        await option.run(mower)
        this.#value = option.label
        this.runtimeState.setCapState(CAP_NAME, this.#slice(mower))
      },
    }
    this.ctx.registerNativeCap(controlCapability, provider)
    this.#publishSlice()
  }

  protected override recomputeSlice(): void {
    // Re-publish so the option list tracks a map that loaded after activate; the
    // selected value is ephemeral (the last fired action) and is preserved.
    this.#publishSlice()
  }
}
