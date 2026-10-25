/**
 * What the composer needs to run a composition on an EXISTING device (D663)
 * besides the runtime and the claim-backed target: the target's description,
 * the claim shapes derived from the plan, and the block report's words.
 *
 * - The target is DESCRIBED (bound caps → native addon, row type) with ONE
 *   `getBindings` per plan change, cached until `device.bindings-changed` for
 *   that device. A read that fails keeps the previous description; with none,
 *   the block waits and nothing is claimed (D49).
 * - A claim's field set is the PLAN's (S5): the top-level fields of the cap, an
 *   item leaf contributing its whole array. Its mode is the feature's.
 * - A self-read of the target (rule 6) is served from the NATIVE view unless it
 *   reads an ADDED cap — that is the composition's own output. Whether a native
 *   cap's `device.state-changed` is the native or the composition's own merge
 *   is NOT decided here from the plan: it follows whether the claim has landed
 *   (`HeldClaims`, C-1).
 */
import {
  type CapabilityLookup,
  type ClaimsListing,
  type CompositionFeaturePlan,
  type CompositionFieldPlan,
  type CompositionFieldState,
  type CompositionSourceRef,
  type CompositionTargetFound,
  compositionItemFieldPath,
  compositionSourceKey,
  type deviceStateCapability,
  type DeviceType,
  type FieldClaimMode,
  type IScopedLogger,
} from '@camstack/types'
import type { z } from 'zod'
import type { ReleasedField } from './composition-runtime.js'
import type { GraftOutcome } from './graft-host.js'
import type { OwnedFieldsApi } from './owned-fields-target.js'
import type { BoundCapsRead } from './source-tracker.js'

export type ListClaimsInput = z.infer<typeof deviceStateCapability.methods.listClaims.input>

/** The hub's claim surface the composer uses: the write target's three methods plus the boot seed. */
export interface ComposerClaimsApi extends OwnedFieldsApi {
  listClaims(input: ListClaimsInput): Promise<ClaimsListing>
}

export interface ExistingTargetSeedRead {
  readonly byCap: ReadonlyMap<string, Readonly<Record<string, unknown>> | null>
}

export interface SeedlessRestoredCapsInput {
  readonly logger: IScopedLogger
  readonly blockId: string
  readonly deviceId: number
  readonly features: readonly CompositionFeaturePlan[]
  readonly seed: ExistingTargetSeedRead
  readonly lookupCap: CapabilityLookup
}

/**
 * Review M3: an ADDED `restored` cap seeded from NOTHING says so, once per
 * runtime build, on its device. After a restart its state comes from the
 * target's runtime-state row; a row that lost the slice (D677: 101's doorbell,
 * dropped at a hub boot) used to surface as "not seeded yet" and now seeds a
 * clean `{ null, 0 }` — a lifetime count silently reset unless this line
 * names it. A first composition of a device that never had the slice logs it
 * too: the line cannot tell the two apart, and says both.
 */
export function reportSeedlessRestoredCaps(input: SeedlessRestoredCapsInput): void {
  for (const cap of addedCapsOf(input.features)) {
    if (input.lookupCap(cap)?.durability !== 'restored') continue
    if ((input.seed.byCap.get(cap) ?? null) !== null) continue
    input.logger.info(
      'composed restored capability seeded from nothing — the target had no slice for it (a first composition, or a lost runtime-state row)',
      {
        tags: { deviceId: input.deviceId },
        meta: { blockId: input.blockId, cap, seededFrom: 'none' },
      },
    )
  }
}

/**
 * Read every affected effective capability exactly once, before the composer
 * grafts or claims any of them. A null slice is a successful empty seed; a
 * rejection is deliberately left to the caller so ownership cannot begin.
 */
export async function readExistingTargetSeeds(
  targetDeviceId: number,
  caps: readonly string[],
  read: (deviceId: number, capName: string) => Promise<Readonly<Record<string, unknown>> | null>,
): Promise<ExistingTargetSeedRead> {
  const byCap = new Map<string, Readonly<Record<string, unknown>> | null>()
  for (const cap of new Set(caps)) byCap.set(cap, await read(targetDeviceId, cap))
  return { byCap }
}

/**
 * The composer's grafts (`GraftHost`, Task 10): a method-serving native for each
 * cap a customization ADDS. Grafted at PLAN time only; removed when a foreign
 * native appears, when the target is gone (Kernel ruling,
 * `DeviceContext.unregisterNativeCap`), or when the block's add claim is
 * released — else the runner keeps a native on that id and `LocalChildRegistry`
 * keeps routing to it.
 */
export interface ComposerGraftPorts {
  graft(deviceId: number, stableId: string, capName: string): GraftOutcome
  ungraft(deviceId: number, capName: string, reason: string): void
  grafted(deviceId: number): ReadonlySet<string>
  /**
   * Retract a binding a PREVIOUS incarnation of the composer left on `deviceId`
   * (I-3): this process never registered it, so `ungraft` cannot reach it. The
   * caller has read that the binding IS the composer's.
   */
  retractStale(deviceId: number, capName: string, reason: string): void
}

/** The reason every ungraft of a gone target carries (Task 9 rule 5 / Task 10 rule 2). */
export const TARGET_GONE_UNGRAFT_REASON = 'target device gone'
export interface GoneTargetUngraft {
  readonly grafts: ComposerGraftPorts | undefined
  readonly logger: IScopedLogger
  readonly blockId: string
  readonly deviceId: number
  readonly ref: CompositionSourceRef
  readonly features: readonly CompositionFeaturePlan[]
}

/**
 * Rule 5, on either path that finds the target gone (`device.unregistered`, or
 * a later plan when that event was dropped): ungraft every cap the block ADDED
 * on that id, with the one ERROR that says so.
 */
export function ungraftGoneTarget(input: GoneTargetUngraft): void {
  const { grafts, deviceId } = input
  const added = addedCapsOf(input.features)
  for (const cap of added) grafts?.ungraft(deviceId, cap, TARGET_GONE_UNGRAFT_REASON)
  input.logger.error(
    'customization target device is gone — the block failed and its grafts are removed; only the operator ends this (edit or restart the block)',
    {
      tags: { deviceId },
      meta: {
        blockId: input.blockId,
        target: compositionSourceKey(input.ref),
        ungrafted: added,
        graftHost: grafts !== undefined,
      },
    },
  )
}

/** ONE `getBindings` read: cap → the addon serving it natively. */
export type DescribeTarget = (deviceId: number) => Promise<BoundCapsRead>

export class TargetDescriptions {
  private cache: ReadonlyMap<string, CompositionTargetFound> = new Map()

  constructor(
    private readonly logger: IScopedLogger,
    private readonly readBoundCaps: DescribeTarget,
  ) {}

  /** `device.bindings-changed` for this device: the next read is a real read. */
  invalidate(deviceId: number): void {
    this.cache = new Map([...this.cache].filter(([, d]) => d.deviceId !== deviceId))
  }

  /**
   * The description of `ref`, resolved to `deviceId`. Served from the cache
   * unless `force` (the block's plan changed) or nothing is cached. A read that
   * fails keeps the previous description of the SAME device id, and answers
   * null when there is none: the caller waits, and claims nothing.
   */
  async describe(
    ref: CompositionSourceRef,
    deviceId: number,
    type: DeviceType,
    force: boolean,
  ): Promise<CompositionTargetFound | null> {
    const key = compositionSourceKey(ref)
    const cached = this.cache.get(key)
    const previous = cached !== undefined && cached.deviceId === deviceId ? cached : null
    if (!force && previous !== null) return previous
    const read = await this.readBoundCaps(deviceId)
    if (read.kind === 'unreadable') {
      this.logger.warn(
        previous === null
          ? 'customization target: its bindings could not be read — nothing is claimed until they are; retried on the next apply'
          : 'customization target: its bindings could not be read — the previous description is kept',
        { tags: { deviceId }, meta: { target: key, error: read.error } },
      )
      return previous
    }
    const found: CompositionTargetFound = { kind: 'found', deviceId, type, nativeCaps: read.caps }
    this.cache = new Map([...this.cache, [key, found]])
    return found
  }
}

/** The PLANNED field set a claim carries for `cap` (S5): an item leaf claims its whole array. */
export function claimFieldsOf(
  fields: readonly CompositionFieldPlan[],
  cap: string,
): readonly string[] {
  return [
    ...new Set(
      fields
        .filter((f) => f.cap === cap)
        .map((f) => (f.item === undefined ? f.path : f.item.arrayPath)),
    ),
  ]
}

/** The claim mode of `cap`: `replace` for a cap the device serves natively, else `add`. */
export function claimModeOf(
  features: readonly CompositionFeaturePlan[],
  cap: string,
): FieldClaimMode {
  return features.find((f) => f.cap === cap)?.mode === 'replace' ? 'replace' : 'add'
}

/** The caps a customization ADDS to its target — the ones it grafts a native for (Task 10). */
export function addedCapsOf(features: readonly CompositionFeaturePlan[]): readonly string[] {
  return features.filter((f) => f.mode === 'add').map((f) => f.cap)
}

/** How the target's own caps are tracked for a block's self-reads (rule 6). */
export interface SelfReadCaps {
  /** Added caps read back: the composition's own output, the effective view. */
  readonly effective: readonly string[]
  /** Every other self-read cap: the native view. */
  readonly native: readonly string[]
}

export function selfReadCaps(
  fields: readonly CompositionFieldPlan[],
  target: CompositionSourceRef,
  features: readonly CompositionFeaturePlan[],
): SelfReadCaps {
  const targetKey = compositionSourceKey(target)
  const read = new Set(
    fields.flatMap((f) =>
      f.reads.filter((r) => compositionSourceKey(r.source) === targetKey).map((r) => r.cap),
    ),
  )
  const added = new Set(addedCapsOf(features))
  return {
    effective: [...read].filter((cap) => added.has(cap)),
    native: [...read].filter((cap) => !added.has(cap)),
  }
}

/** The `degraded` reason (rule 8): one entry per released field, the source's own reason after the dash. */
export function degradedReason(released: readonly ReleasedField[]): string {
  return released
    .map((r) => {
      const path =
        r.item === undefined
          ? r.path
          : compositionItemFieldPath(r.item.arrayPath, r.item.key, r.path)
      return `released to the native provider: ${r.cap}.${path} — ${r.reason}`
    })
    .join('; ')
}

/** The `starting` reason of a block with HELD fields: each keeps its last value and claim until its source answers (D49). */
export function heldReason(held: readonly ReleasedField[]): string {
  return held
    .map((r) => {
      const path =
        r.item === undefined
          ? r.path
          : compositionItemFieldPath(r.item.arrayPath, r.item.key, r.path)
      return `held on its last value until its source answers: ${r.cap}.${path} — ${r.reason}`
    })
    .join('; ')
}

/**
 * Rule 4: a customization whose row exists but whose plan failed keeps its
 * claims, so its owned fields stay at their last value on the hub. The report
 * says so — each field that had a value is `stale`, with the reason.
 */
export function heldFieldsOf(
  fields: readonly CompositionFieldState[],
  reason: string,
): readonly CompositionFieldState[] {
  return fields.map((f) => (f.state === 'unavailable' ? f : { ...f, state: 'stale', reason }))
}
