/**
 * Declared devices — the ownership primitive for a device an addon DECLARES
 * rather than discovers.
 *
 * A provider adopts what a vendor reports. A *declaration* is the other shape:
 * a device exists because an addon says so, in code, on every boot. The NC
 * alarm panel is the live instance of it (device 1023) and, until this module,
 * the only one — hand-rolled inline with eight injected dependencies.
 *
 * What this owns, and why each part is here rather than at the call site:
 *
 * - **Idempotence.** `reconcile` is `get-or-create` on `(addonId, stableId)`
 *   and is safe to run on every boot and on every convergence tick. Nothing
 *   here is one-shot.
 * - **Reconcile, not one-shot (D49).** The destructive branch — "the index does
 *   not list it, so CREATE it with its declared meta" — re-stamps the declared
 *   name over an operator's rename. It therefore requires a SECOND read of the
 *   index to agree before it runs. A read that fails changes nothing at all:
 *   the pass aborts, and the next one converges.
 * - **The name follows the authority.** A declared device's name is seeded ONCE,
 *   at create. Every later pass adopts without meta, because a rename belongs to
 *   the operator and re-stamping it every boot is the losing half of two writers
 *   (D62).
 * - **`fixed` is re-asserted every pass.** The defect the hand-rolled version
 *   shipped with wrote `info.fixed` only on the create path, so an install that
 *   already had the integration never received the flag — the kernel kept
 *   allowing its deletion. Get-or-create is not enough for a flag; it has to be
 *   re-asserted.
 * - **Withdrawal is cleanup.** A declaration removed from the code removes its
 *   device, bounded to the addon's own FIXED integration and logged per device.
 *   Nothing outside that integration is ever touched.
 * - **One owner node.** An addon that runs on every node must not race to own a
 *   cluster singleton. The default placement is `'hub'`.
 *
 * What this deliberately does NOT own: writing a declared device's STATE. The
 * authority for a cap slice is already `deviceState.setCapSlice` (via
 * `BaseDevice.runtimeState` / `ctx.fetchDevice(id)`). A third alias for it would
 * be a second writer of a value that already has one.
 */

import type { IScopedLogger } from '../interfaces/logging.js'
import type { IDevice } from './device.js'
import type { DeviceConstructor, DeviceManagerApi } from './device-context.js'
import type { DeviceType } from './device-type.js'

/** Marker written to a declared integration's `info`. */
export const DECLARED_INTEGRATION_FIXED_KEY = 'fixed'

/** One row of the addon's own device index, as `deviceManager.listAll` reports it. */
export interface DeclaredDeviceRow {
  readonly id: number
  readonly stableId: string
  readonly integrationId?: string | null
}

/** An integration as the integrations store reports it. */
export interface DeclaredIntegrationRow {
  readonly id: string
  readonly info?: Record<string, unknown> | null
}

/**
 * The narrow surface `DeclaredDevices` drives.
 *
 * Ports rather than a whole `AddonContext` for one reason that has cost this
 * repo twice: a fake of the whole context supplies values production forgets to
 * fetch. Five named operations can be faked without inventing behaviour.
 */
export interface DeclaredDevicePorts {
  readonly logger: IScopedLogger
  /** The declaring addon's id — the owner half of `(addonId, stableId)`. */
  readonly addonId: string
  /** `ctx.kernel.devices`. */
  readonly devices: DeviceManagerApi
  /** `ctx.kernel.localNodeId`. A forked child reads `<node>/<addon>`. */
  readonly localNodeId?: string | undefined
  /** `integrations.getByAddonId` — null when this addon has none yet. */
  readonly getIntegration: (addonId: string) => Promise<DeclaredIntegrationRow | null>
  readonly createIntegration: (input: {
    addonId: string
    name: string
    info: Record<string, unknown>
  }) => Promise<{ readonly id: string }>
  /** Merge `info` onto an EXISTING integration. Used to re-assert `fixed`. */
  readonly updateIntegration: (input: {
    id: string
    info: Record<string, unknown>
  }) => Promise<void>
  /**
   * Every device row this addon owns.
   *
   * FALLIBLE on purpose: this is the read the D49 discipline applies to. It may
   * throw, and it may transiently answer `[]` while the registry is cold — which
   * is indistinguishable from "the operator deleted everything".
   */
  readonly listOwnDevices: () => Promise<readonly DeclaredDeviceRow[]>
}

/** One device an addon declares. */
export interface DeviceDeclaration<T extends IDevice = IDevice> {
  /** Stable within the addon, never derived from the name — a rename must not
   *  mint a second device. */
  readonly stableId: string
  /** Seeded ONCE, at create. Never re-stamped (D62). */
  readonly name: string
  readonly type: DeviceType
  readonly DeviceClass: DeviceConstructor<T>
  /** Initial config blob, written before the constructor runs. Create only. */
  readonly config?: Record<string, unknown>
  /** Optional semantic role, stamped at create alongside the type. */
  readonly role?: string
}

/** Where the declaration is owned. */
export type DeclarationPlacement = 'hub' | 'this-node'

export interface DeclaredDevicesSpec {
  /** Display name of the FIXED integration the devices hang from. Unused when
   *  {@link integrationId} names an existing one. */
  readonly integrationName: string
  /**
   * Hang the devices off an integration that ALREADY EXISTS, owned by somebody
   * else. When set, nothing is minted and `fixed` is not re-asserted — the
   * owner of that integration is responsible for both.
   *
   * This exists because a declarer is not always an installed addon. Every
   * integration READ is filtered by `installedAddonIds`
   * (`addon-registry.service.ts` → `createFilteredRegistry`), and a core
   * block's addon id (`core-block-<uuid>`) is never in that set: its
   * `getIntegration` answers null forever, so the mint branch runs on every
   * start and leaks a row `listIntegrations` hides and `deleteIntegration`
   * refuses to delete. Measured on the live hub, 2026-08-09 — two starts of one
   * block left `int_0021` and `int_0022` orphaned and unreachable.
   *
   * A block therefore hangs its devices off the integration the `core-blocks`
   * builtin owns. Ownership of the DEVICE is unaffected: that is
   * `(addonId, stableId)`, and `listOwnDevices` stays addon-scoped, which is
   * what keeps one block's withdrawal sweep away from another's devices.
   */
  readonly integrationId?: string
  readonly devices: readonly DeviceDeclaration[]
  /**
   * Default `'hub'`: a declaration is cluster state and belongs to the node
   * that is always there. `'this-node'` is for a declaration that is genuinely
   * per-node.
   */
  readonly placement?: DeclarationPlacement
}

export interface DeclaredDeviceOutcome {
  readonly stableId: string
  readonly deviceId: number
  readonly device: IDevice
  /** True only on the boot that created it — the operator sees one line, once. */
  readonly created: boolean
}

export interface DeclaredDevicesResult {
  /** Null when this node does not own the declaration (see `placement`). */
  readonly integrationId: string | null
  readonly devices: readonly DeclaredDeviceOutcome[]
  /** Device ids removed because their declaration was withdrawn. */
  readonly removed: readonly number[]
  /** False when the placement gate skipped this node entirely. */
  readonly owned: boolean
}

/**
 * Strip the `<node>/<addon>` suffix a forked child carries.
 *
 * Comparing `ctx.kernel.localNodeId` raw skipped EVERY node — including the one
 * that was supposed to act — because on the hub it reads `hub/<addon>`.
 */
export function declarationOwnerNodeId(localNodeId: string | undefined): string {
  const raw = localNodeId ?? 'hub'
  if (!raw.includes('/')) return raw
  return raw.split('/')[0] ?? 'hub'
}

/** Cap on how many rows one withdrawal pass may delete. */
export const DECLARED_DEVICE_SWEEP_LIMIT = 32

/**
 * The one way an addon owns a device it declares.
 *
 * Construct once with the addon's ports, then call {@link reconcile} on boot and
 * on every convergence tick. There is no second get-or-create helper — a guard
 * in `scripts/` enforces that.
 */
export class DeclaredDevices {
  private readonly ports: DeclaredDevicePorts

  constructor(ports: DeclaredDevicePorts) {
    // `ctx.addonId` DOES NOT EXIST — the addon id is `ctx.id`. Every declarer
    // hand-wires these ports, so reaching for the field that reads like the
    // right one produces `addonId: undefined` with no compiler complaint (the
    // ports type says `string`) and no runtime one either. `listOwnDevices` is
    // wired from this same id, and an owner-less device listing answers with
    // EVERY device on the cluster — which this class would take as its own
    // index. Refuse where the wiring mistake is, not at the first pass that
    // acts on it.
    const addonId: unknown = ports.addonId
    if (typeof addonId !== 'string' || addonId.length === 0) {
      throw new Error(
        `DeclaredDevices: addonId must be the declaring addon's id, got ${JSON.stringify(addonId)}. ` +
          'On an addon context it is `ctx.id` — there is no `ctx.addonId`.',
      )
    }
    this.ports = ports
  }

  /**
   * Converge the declared set. Idempotent, and safe to call repeatedly.
   *
   * Throws only what the ports throw on the FIRST index read; every other
   * failure is per-device and logged, so one bad declaration never takes the
   * others down.
   */
  async reconcile(spec: DeclaredDevicesSpec): Promise<DeclaredDevicesResult> {
    const placement: DeclarationPlacement = spec.placement ?? 'hub'
    if (placement === 'hub') {
      const nodeId = declarationOwnerNodeId(this.ports.localNodeId)
      if (nodeId !== 'hub') {
        this.ports.logger.info('declared devices are hub-owned — skipping on this node', {
          meta: { nodeId, rawNodeId: this.ports.localNodeId ?? null },
        })
        return { integrationId: null, devices: [], removed: [], owned: false }
      }
    }

    // A supplied id is used verbatim: minting and re-asserting `fixed` belong
    // to whoever owns that integration, and a declarer that cannot READ it
    // (see `integrationId`) must not try to own it.
    const integrationId = spec.integrationId ?? (await this.ensureIntegration(spec.integrationName))
    // The index read. Fallible: if it throws, this pass changes NOTHING and the
    // next one converges. That is the whole point of reconciling.
    const index = await this.readIndex()
    // LIVE device objects, by stableId. The persisted index above says a row
    // EXISTS; this says one is already constructed and registered. Read once
    // per pass rather than per declaration — reconcile is a loop over every
    // declared device and `getAll` is not free.
    const live = await this.readLiveByStableId()

    const outcomes: DeclaredDeviceOutcome[] = []
    for (const declaration of spec.devices) {
      const outcome = await this.applyDeclaration(declaration, integrationId, index, live)
      if (outcome !== null) outcomes.push(outcome)
    }

    const removed = await this.sweepWithdrawn(spec.devices, integrationId, index)
    return { integrationId, devices: outcomes, removed, owned: true }
  }

  /**
   * Get-or-create the FIXED integration, and RE-ASSERT the flag every pass.
   *
   * The re-assertion is the fix for the defect the hand-rolled version shipped
   * with: writing `info.fixed` only on the create path left every pre-existing
   * install without it, and the kernel kept offering to delete an integration
   * the addon owns.
   */
  private async ensureIntegration(integrationName: string): Promise<string> {
    const existing = await this.ports.getIntegration(this.ports.addonId)
    if (existing === null) {
      const created = await this.ports.createIntegration({
        addonId: this.ports.addonId,
        name: integrationName,
        info: { [DECLARED_INTEGRATION_FIXED_KEY]: true },
      })
      this.ports.logger.info('declared a fixed integration', {
        meta: { integrationId: created.id, name: integrationName },
      })
      return created.id
    }
    if (existing.info?.[DECLARED_INTEGRATION_FIXED_KEY] !== true) {
      await this.ports.updateIntegration({
        id: existing.id,
        info: { [DECLARED_INTEGRATION_FIXED_KEY]: true },
      })
      this.ports.logger.info('re-asserted `fixed` on a declared integration', {
        meta: { integrationId: existing.id },
      })
    }
    return existing.id
  }

  private async readIndex(): Promise<Map<string, DeclaredDeviceRow>> {
    const rows = await this.ports.listOwnDevices()
    return new Map(rows.map((row) => [row.stableId, row]))
  }

  /**
   * Devices this kernel already has CONSTRUCTED, by stableId.
   *
   * Distinct from {@link readIndex}, and the distinction is the bug: the index
   * is persisted rows, this is live objects. A row without an object must be
   * adopted; an object must be left exactly as it is.
   *
   * Failure is non-fatal and deliberately so — an empty map degrades to the
   * previous behaviour (attempt the adopt) rather than skipping a device that
   * genuinely needs bringing up.
   */
  private async readLiveByStableId(): Promise<ReadonlyMap<string, IDevice>> {
    try {
      const devices = await this.ports.devices.getAll()
      return new Map(devices.map((device) => [device.stableId, device]))
    } catch (err) {
      this.ports.logger.warn('could not read live devices — falling back to adopt-by-row', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return new Map()
    }
  }

  /**
   * One declaration: adopt what exists, create what does not.
   *
   * The create branch is the destructive one — it seeds `initialMeta`, and
   * `initialMeta.name` lands as an unconditional `setName`. A transiently empty
   * index therefore looks exactly like a first boot and would silently re-stamp
   * the declared name over the operator's rename. D49: that branch needs a
   * second read to agree.
   */
  private async applyDeclaration(
    declaration: DeviceDeclaration,
    integrationId: string,
    index: ReadonlyMap<string, DeclaredDeviceRow>,
    live: ReadonlyMap<string, IDevice>,
  ): Promise<DeclaredDeviceOutcome | null> {
    try {
      // ── Already constructed? Then this pass has nothing to do ─────────────
      // `devices.create` ends in `registry.register`, which refuses a SECOND
      // object for an id it already holds. The adopt branch below calls
      // `create` on every pass, so from the second reconcile onward every
      // declared device threw `Device numeric id N already registered` — once a
      // minute, forever — and the camera never came up. Measured on the live
      // hub 2026-08-11: a Terminal instance existed, its camera did not, and
      // the only trace was a warning that printed the SAME stableId on both
      // sides of the error and so read like a self-collision.
      //
      // The accessory-child path already carries this exact guard, with the
      // same rationale (`device-cap-proxy.ts`, "Idempotency guard: reconcile
      // may fire multiple times…"). This is that guard, for declarations.
      const alreadyLive = live.get(declaration.stableId)
      if (alreadyLive !== undefined) {
        return {
          stableId: declaration.stableId,
          deviceId: alreadyLive.id,
          device: alreadyLive,
          created: false,
        }
      }

      let existing = index.get(declaration.stableId)
      if (existing === undefined) {
        const confirmation = await this.readIndex()
        existing = confirmation.get(declaration.stableId)
        if (existing !== undefined) {
          // The reads disagreed in the direction that destroys work. LOG it —
          // a branch that would have dropped an operator's rename is not
          // allowed to be silent.
          this.ports.logger.warn(
            'device index disagreed with itself — adopting instead of re-creating',
            {
              tags: { deviceId: existing.id },
              meta: { stableId: declaration.stableId, addonId: this.ports.addonId },
            },
          )
        }
      }

      if (existing !== undefined) {
        // ADOPT, do not skip. The persisted row carries the id and the
        // operator's name; what it does not carry is a live device object, and
        // returning early leaves the device listed but answering nothing.
        // `initialMeta` is omitted on purpose — the row is canonical.
        const device = await this.ports.devices.create(
          declaration.stableId,
          declaration.DeviceClass,
          {},
          null,
          undefined,
        )
        this.ports.logger.info('declared device adopted', {
          tags: { deviceId: device.id },
          meta: { stableId: declaration.stableId, integrationId },
        })
        return { stableId: declaration.stableId, deviceId: device.id, device, created: false }
      }

      const device = await this.ports.devices.create(
        declaration.stableId,
        declaration.DeviceClass,
        declaration.config ?? {},
        null,
        {
          type: declaration.type,
          name: declaration.name,
          integrationId,
          ...(declaration.role === undefined ? {} : { role: declaration.role }),
        },
      )
      this.ports.logger.info('declared device created', {
        tags: { deviceId: device.id },
        meta: { stableId: declaration.stableId, integrationId },
      })
      return { stableId: declaration.stableId, deviceId: device.id, device, created: true }
    } catch (err) {
      // One bad declaration is a feature missing, not a boot failure. Loud,
      // because the alternative is an operator driving something that is not
      // there.
      this.ports.logger.warn('a declared device could not be brought up', {
        meta: {
          stableId: declaration.stableId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return null
    }
  }

  /**
   * Remove rows under the addon's FIXED integration whose declaration is gone.
   *
   * Bounded to that integration: a declared integration has no operator
   * add-flow, so every row under it got there by declaration. Devices this
   * addon owns OUTSIDE it (a provider's adopted devices) are never candidates.
   *
   * Bounded in count, and every deletion is logged with its `deviceId` — a
   * withdrawal that removes an operator-visible row silently is the failure
   * mode, not the removal itself.
   */
  private async sweepWithdrawn(
    declarations: readonly DeviceDeclaration[],
    integrationId: string,
    index: ReadonlyMap<string, DeclaredDeviceRow>,
  ): Promise<readonly number[]> {
    const declared = new Set(declarations.map((d) => d.stableId))
    const candidates = [...index.values()].filter(
      (row) => row.integrationId === integrationId && !declared.has(row.stableId),
    )
    if (candidates.length === 0) return []
    if (candidates.length > DECLARED_DEVICE_SWEEP_LIMIT) {
      this.ports.logger.warn('withdrawal sweep exceeded its bound — removing nothing', {
        meta: { integrationId, candidates: candidates.length, bound: DECLARED_DEVICE_SWEEP_LIMIT },
      })
      return []
    }

    const removed: number[] = []
    for (const row of candidates) {
      try {
        await this.ports.devices.remove(row.id)
        removed.push(row.id)
        this.ports.logger.info('declared device removed — its declaration was withdrawn', {
          tags: { deviceId: row.id },
          meta: { stableId: row.stableId, integrationId },
        })
      } catch (err) {
        this.ports.logger.warn('a withdrawn declared device could not be removed', {
          tags: { deviceId: row.id },
          meta: {
            stableId: row.stableId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    return removed
  }
}
