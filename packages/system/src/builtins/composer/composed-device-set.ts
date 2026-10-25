/**
 * The composed devices the composer DECLARED (D659): one row per `new`-target
 * block, hung off the shared Blocks integration, adopted or built by
 * `DeclaredDevices.reconcile`. This is the only place a composed row is created,
 * kept or swept — a composition on an EXISTING device never enters it (D663).
 *
 * - `rows` is the set of stableIds whose row exists: seeded from the persisted
 *   rows at boot, then what every declare kept. Planning asks it to decide
 *   whether a block that stopped planning has a row to hold as a placeholder.
 * - A changed shape (type, role, cap set, placeholder or not) needs a NEW device
 *   object: decommission, and let the reconcile adopt it with the new class. A
 *   failure keeps the old device and is retried on the next apply.
 * - A failed reconcile changes nothing (D49): the devices already live stay.
 */
import {
  composedDeviceStableId,
  type DeviceDeclaration,
  errMsg,
  type IScopedLogger,
} from '@camstack/types'
import type { ComposedDeviceHandle } from './composed-device.js'
import type { ComposerDerivedSpec, PlannedBlock } from './composer-plan.js'
import type { PersistedComposedRow } from './composition-declarations.js'

export interface ComposerDevicePorts {
  setName(deviceId: number, name: string): Promise<void>
  decommission(deviceId: number): Promise<void>
  applyDerivedSpec(deviceId: number, derived: ComposerDerivedSpec): Promise<void>
}

export interface ComposerDeclareResult {
  /** Live composed devices by stableId. */
  readonly devices: ReadonlyMap<string, ComposedDeviceHandle>
}

export type ComposerDeclare = (
  integrationId: string,
  devices: readonly DeviceDeclaration[],
) => Promise<ComposerDeclareResult>

export interface ComposedDeviceSetDeps {
  readonly logger: IScopedLogger
  readonly declare: ComposerDeclare
  readonly devices: ComposerDevicePorts
}

/** What `rebuildShapes` needs of a block's previous apply: its live device and the shape it was built for. */
export interface PreviousShape {
  readonly device: ComposedDeviceHandle | null
  readonly shape: string | null
}

export class ComposedDeviceSet {
  private devices: ReadonlyMap<string, ComposedDeviceHandle> = new Map()
  private existingRows: ReadonlySet<string> = new Set()
  private declaredFingerprint: string | null = null

  constructor(private readonly deps: ComposedDeviceSetDeps) {}

  /** StableIds whose row exists. */
  get rows(): ReadonlySet<string> {
    return this.existingRows
  }

  seedRows(rows: readonly PersistedComposedRow[]): void {
    this.existingRows = new Set(rows.map((r) => r.stableId))
  }

  get(stableId: string): ComposedDeviceHandle | null {
    return this.devices.get(stableId) ?? null
  }

  idOf(stableId: string): number | null {
    return this.devices.get(stableId)?.id ?? null
  }

  async rebuildShapes(
    planned: readonly PlannedBlock[],
    previousOf: (blockId: string) => PreviousShape | undefined,
  ): Promise<ReadonlyMap<string, string>> {
    const errors = new Map<string, string>()
    for (const p of planned) {
      const previous = previousOf(p.block.id)
      const device = previous?.device ?? null
      if (previous === undefined || device === null || p.shape === null) continue
      if (previous.shape === p.shape) continue
      try {
        this.deps.logger.info('composition shape changed — rebuilding its device', {
          tags: { deviceId: device.id },
          meta: { blockId: p.block.id, from: previous.shape, to: p.shape },
        })
        if (p.spec !== null) await this.deps.devices.applyDerivedSpec(device.id, p.spec)
        await this.deps.devices.decommission(device.id)
        const stableId = composedDeviceStableId(p.block.id)
        this.devices = new Map([...this.devices].filter(([s]) => s !== stableId))
        this.declaredFingerprint = null
      } catch (err: unknown) {
        const error = errMsg(err)
        errors.set(p.block.id, error)
        this.deps.logger.warn('rebuilding a composed device failed — the old one is kept', {
          tags: { deviceId: device.id },
          meta: { blockId: p.block.id, error },
        })
      }
    }
    return errors
  }

  async reconcile(
    integrationId: string,
    declarations: readonly DeviceDeclaration[],
    planned: readonly PlannedBlock[],
  ): Promise<void> {
    const shapes = new Map(
      planned.flatMap((p) =>
        p.declaration === null ? [] : [[p.declaration.stableId, p.shape] as const],
      ),
    )
    const fingerprint = JSON.stringify(
      declarations.map((d) => [d.stableId, shapes.get(d.stableId) ?? null]).toSorted(),
    )
    const allLive = declarations.every((d) => this.devices.has(d.stableId))
    if (fingerprint === this.declaredFingerprint && allLive) return
    try {
      const result = await this.deps.declare(integrationId, declarations)
      this.devices = result.devices
      // A row a declaration kept still exists even if its device failed to build.
      this.existingRows = new Set(
        declarations
          .map((d) => d.stableId)
          .filter((s) => this.existingRows.has(s) || result.devices.has(s)),
      )
      this.declaredFingerprint = fingerprint
    } catch (err: unknown) {
      // A failed reconcile changes nothing (D49): the devices we had stay.
      this.deps.logger.warn(
        'composer: the device declaration failed — keeping the devices already live',
        { meta: { error: errMsg(err), declarations: declarations.length } },
      )
    }
  }
}
