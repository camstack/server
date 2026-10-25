import { z } from 'zod'
import {
  enumSensorCapability,
  type DeviceContext,
  type EnumSensorStatus,
  type InferNativeProvider,
} from '@camstack/types'
import { enumSensorOptionsFor } from '../dreame-entity-catalog.js'
import { dreameChildSchema } from './dreame-child-device.js'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'enum-sensor'

/** One persisted enum option: the MIoT int value + its display label. */
const dreameEnumOptionSchema = z.object({
  value: z.number().int(),
  label: z.string().min(1),
})

/** Persisted config for a generic enum-sensor child: the shared Dreame child
 *  config plus the MIoT coordinates + the int→label map from the entity catalog. */
export const dreameEnumSensorSchema = dreameChildSchema.extend({
  siid: z.number().int().nonnegative(),
  piid: z.number().int().nonnegative(),
  label: z.string().optional(),
  options: z.array(dreameEnumOptionSchema).min(1),
})

export type DreameEnumSensorConfig = z.infer<typeof dreameEnumSensorSchema>

/**
 * A read-only Dreame enum-state sensor exposed as a `DeviceType.Sensor` child
 * (`enum-sensor` cap) under the robot Container, backed by ONE int MIoT property
 * read through the shared handle's generic `getProperty`. The reported int is
 * mapped to its label via the catalog's option map; an int NOT in the map
 * surfaces as its raw string (read-only — a raw fallback is informative, unlike
 * a writable select where an unmapped value is left blank). Catalog-driven (see
 * `dreame-entity-catalog.ts` `DREAME_ENUM_SENSORS`) — no per-sensor class.
 */
export class DreameEnumSensorDevice extends DreameChildDevice {
  readonly #siid: number
  readonly #piid: number
  readonly #options: readonly { value: number; label: string }[]

  constructor(ctx: DeviceContext) {
    super(ctx)
    const cfg = dreameEnumSensorSchema.parse(ctx.persistedConfig ?? {})
    this.#siid = cfg.siid
    this.#piid = cfg.piid
    // Prefer the LIVE catalog option map (so label changes — e.g. the benign
    // MiotError remap — apply to already-adopted children on reboot); fall back
    // to the persisted map for anything the catalog no longer describes.
    this.#options = enumSensorOptionsFor(cfg.siid, cfg.piid) ?? cfg.options
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:enum:${cfg.siid}-${cfg.piid}`,
      system: 'dreame',
    })
  }

  /** Read the configured property's int and resolve it to a label, falling back
   *  to its raw string. Returns null only when the property is absent entirely. */
  #readLabel(): string | null {
    const v = this.resolveHandle()?.getProperty(this.#siid, this.#piid)?.value
    if (typeof v !== 'number') return null
    return this.#options.find((o) => o.value === v)?.label ?? String(v)
  }

  #slice(value: string): EnumSensorStatus {
    return { value, lastFetchedAt: Date.now() }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof enumSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EnumSensorStatus>(CAP_NAME) ??
        this.#slice(this.#readLabel() ?? ''),
    }
    this.ctx.registerNativeCap(enumSensorCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, this.#slice(this.#readLabel() ?? ''))
  }

  protected override recomputeSlice(): void {
    const label = this.#readLabel()
    if (label === null) return
    const current = this.runtimeState.getCapState<EnumSensorStatus>(CAP_NAME)
    if (current?.value === label) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(label))
  }
}
