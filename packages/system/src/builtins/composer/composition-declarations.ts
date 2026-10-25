/**
 * Which composed devices exist (D659): one declaration per composition block,
 * owned by `composer` and hung off the shared Blocks integration.
 *
 * `DeclaredDevices` sweeps any row whose declaration is absent. A block missing
 * from ONE apply (a transient store read, a race) would delete the device, and
 * with it its id, exports and rules. The `WithdrawalGate` is D49 for that path:
 * a withdrawal needs a second consecutive apply to agree. The other half of the
 * rule — nothing is declared or withdrawn while the `core_blocks` store has not
 * loaded — is `Composer.apply`'s, which never reaches this gate then (R2).
 */
import {
  type CapabilityDefinition,
  type CompositionNewTarget,
  composedDeviceStableId,
  type DeviceDeclaration,
  DeviceType,
  type IScopedLogger,
  type LogTags,
} from '@camstack/types'
import { ComposedPlaceholderDevice, composedDeviceClass } from './composed-device.js'

export interface ComposerDeclarationInput {
  readonly blockId: string
  readonly name: string
  readonly target: CompositionNewTarget
  readonly caps: readonly CapabilityDefinition[]
}

export function declarationFor(input: ComposerDeclarationInput): DeviceDeclaration {
  return {
    stableId: composedDeviceStableId(input.blockId),
    name: input.name,
    type: input.target.type,
    DeviceClass: composedDeviceClass(input.target.type, input.caps),
    ...(input.target.role === undefined ? {} : { role: input.target.role }),
  }
}

/** What forces a rebuild of the live device: type, role, cap set. Never the name. */
export function shapeOf(input: ComposerDeclarationInput): string {
  return JSON.stringify([
    input.target.type,
    input.target.role ?? null,
    input.caps.map((c) => c.name).toSorted(),
  ])
}

/**
 * The numeric id of the live composed device behind a stableId, or null when
 * none was ever built (its declare failed). Every gate line carries it as
 * `tags.deviceId` — the id the operator asks about (CLAUDE.md "Logging").
 */
export type ComposedDeviceIdOf = (stableId: string) => number | null

/**
 * The declaration that holds a persisted composed row whose block has no plan
 * in this apply. `name` and `type` are used only if the row has to be CREATED,
 * which `DeclaredDevices` does not do for a row it finds: it adopts it, and the
 * row's own name and type stay canonical (`ComposedPlaceholderDevice`).
 */
export function placeholderDeclaration(stableId: string): DeviceDeclaration {
  return {
    stableId,
    name: stableId,
    type: DeviceType.Generic,
    DeviceClass: ComposedPlaceholderDevice,
  }
}

/** A composed device row that already exists — `DeclaredDevicePorts.listOwnDevices()` answers these. */
export interface PersistedComposedRow {
  readonly id: number
  readonly stableId: string
}

const WITHDRAWAL_CONFIRMATIONS = 2

export class WithdrawalGate {
  private known: ReadonlyMap<string, DeviceDeclaration> = new Map()
  private misses: ReadonlyMap<string, number> = new Map()
  private persistedIds: ReadonlyMap<string, number> = new Map()

  constructor(
    private readonly logger: IScopedLogger,
    private readonly deviceIdOf: ComposedDeviceIdOf,
  ) {}

  /**
   * The rows that exist before this process applied anything. Called once at
   * boot, before the first `filter`: without it the mirror starts empty and a
   * row missing from the first apply after a restart (a release, a block that
   * no longer plans) is swept at once — one apply, not two. A seeded row
   * missing from that apply counts as its FIRST miss and is held by
   * `placeholderDeclaration`. A row the gate already knows keeps its entry and
   * its miss count.
   */
  seed(rows: readonly PersistedComposedRow[]): void {
    const fresh = rows.filter((row) => !this.known.has(row.stableId))
    this.known = new Map([
      ...this.known,
      ...fresh.map((row) => [row.stableId, placeholderDeclaration(row.stableId)] as const),
    ])
    this.persistedIds = new Map([
      ...this.persistedIds,
      ...rows.map((row) => [row.stableId, row.id] as const),
    ])
  }

  filter(current: readonly DeviceDeclaration[]): readonly DeviceDeclaration[] {
    const present = new Map(current.map((d) => [d.stableId, d]))
    const kept: DeviceDeclaration[] = []
    const misses = new Map<string, number>()
    for (const [stableId, declaration] of this.known) {
      if (present.has(stableId)) continue
      const count = (this.misses.get(stableId) ?? 0) + 1
      if (count < WITHDRAWAL_CONFIRMATIONS) {
        this.logger.warn(
          'a composition vanished from one apply — its device is kept until a second apply agrees',
          { tags: this.tagsOf(stableId), meta: { stableId, misses: count } },
        )
        kept.push(declaration)
        misses.set(stableId, count)
        continue
      }
      this.logger.info(
        'a composition is gone on two consecutive applies — its device is withdrawn',
        { tags: this.tagsOf(stableId), meta: { stableId } },
      )
    }
    this.known = new Map([...kept.map((d) => [d.stableId, d] as const), ...present])
    this.misses = misses
    return [...current, ...kept]
  }

  /**
   * The live device's id, else the persisted row's. A declaration whose device
   * was never built and never persisted has no numeric id to carry: the
   * stableId in `meta` is then all there is.
   */
  private tagsOf(stableId: string): LogTags {
    const deviceId = this.deviceIdOf(stableId) ?? this.persistedIds.get(stableId) ?? null
    return deviceId === null ? {} : { deviceId }
  }
}
