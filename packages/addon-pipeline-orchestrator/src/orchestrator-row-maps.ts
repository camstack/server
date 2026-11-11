/**
 * `orchestrator-row-maps.ts` — the orchestrator's three id-keyed collections as ROWS (D986 §2).
 *
 * `nodeBindings` and `agentSettings` were one JSON key each, a map keyed on node id; a node that
 * was forgotten left its entry behind. They are now one node row per node,
 * `<addonId>.<field>@<nodeId>` carrying `nodeId`, which the central node forget removes with
 * every other node row. `cameraSettings` was a map keyed on device id; it is now the field
 * `cameraSettings` of the device's own per-device store (`addon-device-settings`, D865), which
 * the device-removal hook already clears.
 *
 * The three classes keep the shape the store always had (read one, read all, write one, remove
 * one), so a caller reads "the settings of node N" without knowing where the bytes are. A READ
 * never swallows a failed store: an unanswered read throws, it is never "no entry". An entry
 * that fails its schema is skipped and named in the log, never replaced by a default.
 *
 * The legacy map keys were copied by the migrations of `migrations/index.ts`, whose last step
 * deletes them once every copy is applied; nothing here reads them.
 */
import type { DurableState, IScopedLogger } from '@camstack/types'
import type { ZodType } from 'zod'

export interface NodeRowsDeps {
  /** `BaseAddon.state<T>()`: the one write door of a settings key. */
  readonly state: <T>(key: string, schema: ZodType<T>, fallback: T) => DurableState<T>
  /** The addon's raw global store, every key; throws when it cannot be read. */
  readonly readStore: () => Promise<Readonly<Record<string, unknown>>>
  readonly logger: IScopedLogger
}

/** A node id that is a real one: the orchestrator refuses to persist the others. */
export const isNodeId = (nodeId: string): boolean =>
  nodeId.length > 0 && nodeId !== 'undefined' && nodeId !== 'null' && !nodeId.includes('@')

/** One node row per node: `<field>@<nodeId>`. */
export class NodeRows<T> {
  constructor(
    private readonly deps: NodeRowsDeps,
    private readonly field: string,
    private readonly schema: ZodType<T>,
  ) {}

  private keyOf(nodeId: string): string {
    return `${this.field}@${nodeId}`
  }

  private parse(nodeId: string, raw: unknown): T | undefined {
    if (raw === undefined) return undefined
    const parsed = this.schema.safeParse(raw)
    if (parsed.success) return parsed.data
    this.deps.logger.warn(`${this.field} row failed validation — ignored`, {
      tags: { nodeId },
      meta: { field: this.field, error: parsed.error.message },
    })
    return undefined
  }

  async get(nodeId: string): Promise<T | undefined> {
    return this.parse(nodeId, (await this.deps.readStore())[this.keyOf(nodeId)])
  }

  /** Every node that has a row, by node id. */
  async getAll(): Promise<Record<string, T>> {
    const prefix = `${this.field}@`
    const out: Record<string, T> = {}
    for (const [key, raw] of Object.entries(await this.deps.readStore())) {
      if (!key.startsWith(prefix)) continue
      const nodeId = key.slice(prefix.length)
      if (!isNodeId(nodeId)) continue
      const value = this.parse(nodeId, raw)
      if (value !== undefined) out[nodeId] = value
    }
    return out
  }

  async set(nodeId: string, value: T): Promise<void> {
    await this.deps.state<T>(this.keyOf(nodeId), this.schema, value).set(value)
  }

  /** Delete the node's row; whether one existed. A failed read throws. */
  async remove(nodeId: string): Promise<boolean> {
    const existed = this.keyOf(nodeId) in (await this.deps.readStore())
    if (!existed) return false
    // A write of `undefined` removes the key (the settings door's contract).
    const optional = this.schema.optional()
    await this.deps.state(this.keyOf(nodeId), optional, undefined).set(undefined)
    return true
  }

  /**
   * Make the rows equal `next` given they held `prev`: a node whose entry changed is written, a
   * node that is gone is removed, an untouched node is not written at all.
   */
  async applyDiff(
    prev: Readonly<Record<string, T>>,
    next: Readonly<Record<string, T>>,
  ): Promise<void> {
    for (const [nodeId, value] of Object.entries(next)) {
      if (JSON.stringify(prev[nodeId]) !== JSON.stringify(value)) await this.set(nodeId, value)
    }
    for (const nodeId of Object.keys(prev)) {
      if (!(nodeId in next)) await this.remove(nodeId)
    }
  }
}

/** The slice of `ctx.settings` the per-device rows go through (D865). */
export interface DeviceRowsPort {
  readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
  listDeviceStoreIds(): Promise<readonly number[]>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
}

export interface DeviceRowsDeps {
  /** `null` when this context has no settings door (after shutdown): every call then throws. */
  readonly deviceSettings: () => DeviceRowsPort | null
  readonly logger: IScopedLogger
}

/** One field of the per-device store, per device. */
export class DeviceRows<T> {
  constructor(
    private readonly deps: DeviceRowsDeps,
    private readonly field: string,
    private readonly schema: ZodType<T>,
  ) {}

  private port(): DeviceRowsPort {
    const port = this.deps.deviceSettings()
    if (port === null)
      throw new Error(`${this.field}: the per-device settings store is unavailable`)
    return port
  }

  private parse(deviceId: number, blob: Readonly<Record<string, unknown>>): T | undefined {
    const raw = blob[this.field]
    if (raw === undefined) return undefined
    const parsed = this.schema.safeParse(raw)
    if (parsed.success) return parsed.data
    this.deps.logger.warn(`${this.field} row failed validation — ignored`, {
      tags: { deviceId },
      meta: { field: this.field, error: parsed.error.message },
    })
    return undefined
  }

  async get(deviceId: number): Promise<T | undefined> {
    return this.parse(deviceId, await this.port().readDeviceStore(deviceId))
  }

  /** Every device that has the field, by device id as a string (the legacy map's key). */
  async getAll(): Promise<Record<string, T>> {
    const port = this.port()
    const out: Record<string, T> = {}
    for (const [deviceId, blob] of await port.readDeviceStoreBatch(
      await port.listDeviceStoreIds(),
    )) {
      const value = this.parse(deviceId, blob)
      if (value !== undefined) out[String(deviceId)] = value
    }
    return out
  }

  async set(deviceId: number, value: T): Promise<void> {
    await this.port().writeDeviceStore(deviceId, { [this.field]: this.schema.parse(value) })
  }

  async remove(deviceId: number): Promise<void> {
    await this.port().writeDeviceStore(deviceId, { [this.field]: undefined })
  }
}
