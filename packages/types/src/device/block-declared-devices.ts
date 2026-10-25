/**
 * Helper for core-block scripts that declare devices on the shared Blocks
 * integration and optionally expose them to exporters.
 *
 * Blocks cannot mint their own integration (D97). They reconcile onto the
 * hub-owned `Blocks` integration (`core-blocks`) and own devices under
 * `ctx.id` (`core-block-<uuid>`). Exporters never scan — after reconcile,
 * call {@link exposeBlockDevices} for each exporter that should publish.
 *
 * Usage inside a block:
 *
 * ```ts
 * import {
 *   DeviceType,
 *   BaseDevice,
 *   reconcileBlockDevices,
 *   exposeBlockDevices,
 *   type AddonContext,
 * } from '@camstack/types'
 *
 * class WanAlertSensor extends BaseDevice {}
 *
 * export default async function block(ctx: AddonContext) {
 *   const { devices } = await reconcileBlockDevices(ctx, {
 *     devices: [{
 *       stableId: 'wan-alert',
 *       name: 'WAN alert',
 *       type: DeviceType.Sensor,
 *       DeviceClass: WanAlertSensor,
 *     }],
 *   })
 *   await exposeBlockDevices(ctx, {
 *     deviceIds: devices.map((d) => d.deviceId),
 *     exporterAddonIds: ['provider-homeassistant'],
 *   })
 *   return () => undefined
 * }
 * ```
 */

import { CORE_BLOCKS_ADDON_ID } from '../capabilities/core-blocks.cap.js'
import type { AddonContext } from '../interfaces/addon.js'
import {
  DeclaredDevices,
  type DeclarationPlacement,
  type DeclaredDevicesResult,
  type DeviceDeclaration,
} from './declared-device.js'

export interface ReconcileBlockDevicesInput {
  readonly devices: readonly DeviceDeclaration[]
  /** Defaults to hub placement. */
  readonly placement?: DeclarationPlacement
}

/**
 * Reconcile the block's declared devices onto the shared Blocks integration.
 * Uses `ctx.id` as the owning addon id — never a fictional `ctx.addonId`.
 *
 * When the Blocks integration is not ready yet, returns `owned: false` with
 * empty devices so the next converge (or the next boot tick) can retry —
 * same discipline as declaring before `armBlocksIntegration` lands.
 */
export async function reconcileBlockDevices(
  ctx: AddonContext,
  input: ReconcileBlockDevicesInput,
): Promise<DeclaredDevicesResult> {
  const int = await ctx.api.integrations.getByAddonId.query({ addonId: CORE_BLOCKS_ADDON_ID })
  if (int === null || int === undefined) {
    ctx.logger.warn('reconcileBlockDevices: Blocks integration is not ready — skipping this pass', {
      meta: { blockAddonId: ctx.id },
    })
    return { integrationId: null, devices: [], removed: [], owned: false }
  }

  // Mint/update ports throw: when `integrationId` is supplied, DeclaredDevices
  // never calls them. Naming the throw surfaces a wiring regression loudly.
  const declared = new DeclaredDevices({
    logger: ctx.logger.child('declared-devices'),
    addonId: ctx.id,
    devices: ctx.kernel.devices,
    localNodeId: ctx.kernel.localNodeId,
    getIntegration: async () => {
      throw new Error(
        'reconcileBlockDevices: devices hang off the Blocks integration; it never reads its own',
      )
    },
    createIntegration: async () => {
      throw new Error(
        'reconcileBlockDevices: devices hang off the Blocks integration; it never mints one',
      )
    },
    updateIntegration: async () => {
      throw new Error(
        'reconcileBlockDevices: devices hang off the Blocks integration; it never updates one',
      )
    },
    listOwnDevices: () => ctx.api.deviceManager.listAll.query({ addonId: ctx.id }),
  })

  return declared.reconcile({
    integrationId: int.id,
    integrationName: int.name,
    placement: input.placement ?? 'hub',
    devices: input.devices,
  })
}

export interface ExposeBlockDevicesInput {
  readonly deviceIds: readonly number[]
  /** Exporter addon ids (e.g. `provider-homeassistant`, `export-hap`). */
  readonly exporterAddonIds: readonly string[]
}

/**
 * Opt-in expose for each device × exporter. Idempotent per pair.
 * Failures are logged per device and do not abort the rest (D391).
 */
export async function exposeBlockDevices(
  ctx: AddonContext,
  input: ExposeBlockDevicesInput,
): Promise<void> {
  for (const exporterAddonId of input.exporterAddonIds) {
    for (const deviceId of input.deviceIds) {
      try {
        await ctx.api.deviceExport.exposeDevice.mutate({
          addonId: exporterAddonId,
          deviceId: String(deviceId),
          nodeId: 'hub',
        })
      } catch (err: unknown) {
        ctx.logger.warn('exposeBlockDevices: expose refused', {
          tags: { deviceId },
          meta: {
            exporterAddonId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }
}
