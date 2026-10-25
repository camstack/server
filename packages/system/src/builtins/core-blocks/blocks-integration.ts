/**
 * The integration every block's devices hang from.
 *
 * ## Why it is not the block's own
 *
 * A core block CANNOT own an integration, and the failure was silent and
 * accumulating. Every integration READ is gated on the installed-addon set
 * (`addon-registry.service.ts` → `createFilteredRegistry`), and a block's addon
 * id — `core-block-<uuid>` — is never in that set: a block is materialised and
 * spawned, not installed. So `getIntegrationByAddonId` answered `null` forever
 * while `createIntegration` succeeded, and every block start minted a fresh row
 * that `listIntegrations` then hid and `integrations.delete` refused to remove.
 * Measured on the live hub 2026-08-09: `int_0021` and `int_0022`, two starts of
 * one block, invisible and undeletable through the API.
 *
 * `core-blocks` is an installed builtin, so it passes the filter. It reconciles
 * ONE integration; a block names that integration by id
 * (`DeclaredDevicesSpec.integrationId`) and mints nothing. Ownership of the
 * DEVICE is untouched — that is `(addonId, stableId)`, and `listOwnDevices`
 * stays addon-scoped, which is what keeps one block's withdrawal sweep away
 * from another block's devices now that the integration no longer distinguishes
 * them.
 *
 * The block-side read is
 * `ctx.api.integrations.getByAddonId.query({ addonId: CORE_BLOCKS_ADDON_ID })`
 * — legal, because `core-blocks` is installed. No new cap method is needed.
 */

import {
  CORE_BLOCKS_ADDON_ID,
  type DeclaredDevicePorts,
  DeclaredDevices,
  errMsg,
  type IScopedLogger,
} from '@camstack/types'

/** Operator-visible name of the shared integration. Seeded once, at create. */
export const BLOCKS_INTEGRATION_NAME = 'Blocks'

/**
 * The declared-device ports minus the owner — `reconcileBlocksIntegration`
 * pins that itself, because getting it wrong is the entire bug above.
 */
export type BlocksIntegrationPorts = Omit<DeclaredDevicePorts, 'addonId'>

/**
 * Reconcile the shared integration. Idempotent; safe on every boot.
 *
 * Returns its id, or `null` when this node does not own the declaration (it is
 * hub-owned, like every declaration).
 *
 * **The trap, stated where it lives:** `devices: []` makes every row the index
 * returns under this integration a withdrawal candidate. That is safe ONLY
 * because `listOwnDevices` is scoped to `core-blocks` and a block's devices are
 * owned by `core-block-<uuid>` — so the listing is empty. Two ways to destroy
 * that: wire `listOwnDevices` without its owner filter (it would then answer
 * with every device on the cluster, and the sweep would delete the blocks'), or
 * make `core-blocks` declare a device of its own. Neither is worth the
 * convenience; the spec test pins both.
 *
 * A SECOND owner hangs devices here since D659: `composer` (every composed
 * device). It is equally safe for the same reason — its rows are owned by
 * `composer`, never by `core-blocks`, and its own withdrawal sweep is scoped to
 * `composer`.
 */
export async function reconcileBlocksIntegration(
  ports: BlocksIntegrationPorts,
): Promise<string | null> {
  const declared = new DeclaredDevices({ ...ports, addonId: CORE_BLOCKS_ADDON_ID })
  const result = await declared.reconcile({
    integrationName: BLOCKS_INTEGRATION_NAME,
    devices: [],
  })
  return result.integrationId
}

/** Retry cadence for {@link armBlocksIntegration}. The gap it waits out is the
 *  rest of hub boot — `$core-caps` is registered once `app.init()` returns — so
 *  seconds, and a handful of them, is the right shape. */
const ARM_RETRY_DELAY_MS = 5_000
/** Bounded, because an integration that will never reconcile must say so once
 *  rather than log forever. Roughly two minutes at the default cadence. */
const ARM_MAX_ATTEMPTS = 24

/** What {@link armBlocksIntegration} needs, and the seam its spec drives. */
export interface ArmBlocksIntegrationOptions {
  readonly logger: IScopedLogger
  readonly reconcile: () => Promise<string | null>
  readonly onLanded: (integrationId: string | null) => void
  readonly retryDelayMs?: number
  readonly maxAttempts?: number
}

/** A reconcile running in the background, and a handle to await in tests. */
export interface ArmedBlocksIntegration {
  readonly settled: Promise<void>
}

/**
 * Arm the shared integration WITHOUT putting it on the boot path (D167).
 *
 * `integrations` is a hub-core namespace served by the `$core-caps` Moleculer
 * service, and that service is registered only after `app.init()` returns —
 * which is where the entire addon boot runs. During boot the read is therefore
 * not slow, it is unanswerable: it burns the full 30 s discovery deadline and
 * fast-fails, with no boot-window retry (core caps are excluded from it).
 *
 * Awaited inside `onInitialize()`, that 30 s sat on the hub's SERIAL in-process
 * builtin loop and delayed `device-manager` — which every provider runner waits
 * on before it may publish a single capability. Measured 2026-08-15: builtins
 * stalled t0+10 s → t0+40 s, and the first camera's first keyframe landed at
 * t0+75 s.
 *
 * So: arm it, let boot finish, and let the retry land it a few seconds later. A
 * block that declares a device before it lands finds `null` and gets the
 * integration on the next converge tick — which was already the documented
 * behaviour when the API was unavailable.
 */
export function armBlocksIntegration(options: ArmBlocksIntegrationOptions): ArmedBlocksIntegration {
  const retryDelayMs = options.retryDelayMs ?? ARM_RETRY_DELAY_MS
  const maxAttempts = options.maxAttempts ?? ARM_MAX_ATTEMPTS
  const settled = (async (): Promise<void> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        options.onLanded(await options.reconcile())
        return
      } catch (err: unknown) {
        if (attempt === maxAttempts) {
          // Loud, once. A block that declares a device now has nowhere to hang
          // it, and silence would read as "there were no blocks".
          options.logger.warn(
            'core-blocks: the shared integration never reconciled — a block that declares a device has nowhere to hang it',
            { meta: { attempts: attempt, error: errMsg(err) } },
          )
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  })()
  return { settled }
}
