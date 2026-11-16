/**
 * Engine-hosted blocks (planning#580): a Camera grid or a Terminal camera is a
 * core block whose camera row `(composer, composed-<blockId>)` the composer
 * owns, and whose camera caps an ENGINE (the camera-grid builtin, the Terminal
 * addon) serves as a cross-addon native on that row (D663). The engine keeps no
 * list of its own (D3): every pass it reads the blocks (`listCompositions`) and
 * the composer's rows, and hosts what both name.
 *
 * Three pieces, shared by both engines:
 *
 * - `selectEngineHostedBlocks` — the blocks of one helper kind whose row
 *   exists. `not-loaded` is UNTRUSTED, never an empty list (D315/D49).
 * - `HostedWithdrawalGate` — a hosted block is withdrawn only after two
 *   consecutive trusted reads agree it is gone (D49).
 * - `hostEngineDevice` — build the engine's device on the foreign row through
 *   `loadContext` (D677) and withdraw exactly the natives it registered.
 */
import type { CompositionListRead } from '../capabilities/core-blocks.cap.js'
import type {
  DeviceConstructor,
  DeviceContext,
  DeviceManagerApi,
} from '../device/device-context.js'
import type { IDevice } from '../device/device.js'
import { COMPOSED_DEVICE_STABLE_ID_PREFIX } from './composed-stable-id.js'
import type { Composition } from './composition.js'
import type { EngineHostedHelperKind, EngineHostedHelperSpec } from './helpers/spec.js'

/** A composer device row, as `deviceManager.listAll({ addonId: 'composer' })` lists it. */
export interface ComposerDeviceRow {
  readonly id: number
  readonly stableId: string
}

/** The spec of one engine-hosted helper kind. */
export type EngineHostedSpecOf<K extends EngineHostedHelperKind> = Extract<
  EngineHostedHelperSpec,
  { readonly kind: K }
>

/** One block an engine serves, joined with the composer row that carries its camera. */
export interface EngineHostedBlock<S extends EngineHostedHelperSpec> {
  readonly blockId: string
  readonly deviceId: number
  readonly stableId: string
  readonly name: string
  readonly enabled: boolean
  /** What `updateComposition` needs as `expectedUpdatedAt`. */
  readonly updatedAt: number
  readonly composition: Composition
  readonly spec: S
}

export type EngineHostedBlocksRead<S extends EngineHostedHelperSpec> =
  | { readonly kind: 'trusted'; readonly blocks: readonly EngineHostedBlock<S>[] }
  | { readonly kind: 'untrusted'; readonly reason: string }

function isSpecOfKind<K extends EngineHostedHelperKind>(
  spec: Composition['helper'],
  kind: K,
): spec is EngineHostedSpecOf<K> {
  return spec !== undefined && spec.kind === kind
}

/**
 * The blocks of `kind` whose composer row exists. A block whose row the
 * composer has not declared yet is left out: nothing can be hosted on it until
 * its next apply, and the next pass picks it up.
 */
export function selectEngineHostedBlocks<K extends EngineHostedHelperKind>(
  kind: K,
  compositions: CompositionListRead,
  composerRows: readonly ComposerDeviceRow[],
): EngineHostedBlocksRead<EngineHostedSpecOf<K>> {
  if (compositions.state === 'not-loaded') {
    return { kind: 'untrusted', reason: compositions.reason }
  }
  const rowByStableId = new Map(composerRows.map((row) => [row.stableId, row] as const))
  const blocks: EngineHostedBlock<EngineHostedSpecOf<K>>[] = []
  for (const view of compositions.views) {
    const block = view.block
    const composition = block.source?.kind === 'composition' ? block.source.composition : null
    if (composition === null) continue
    const spec = composition.helper
    if (!isSpecOfKind(spec, kind)) continue
    const stableId = `${COMPOSED_DEVICE_STABLE_ID_PREFIX}${block.id}`
    const row = rowByStableId.get(stableId)
    if (row === undefined) continue
    blocks.push({
      blockId: block.id,
      deviceId: row.id,
      stableId,
      name: block.name,
      enabled: block.enabled,
      updatedAt: block.updatedAt,
      composition,
      spec,
    })
  }
  return { kind: 'trusted', blocks }
}

const WITHDRAWAL_CONFIRMATIONS = 2

/**
 * D49 for an engine's hosted set: a block missing from ONE trusted read is
 * kept; a second consecutive trusted read that agrees withdraws it. An
 * untrusted read is never fed here, so it neither counts nor resets.
 */
export class HostedWithdrawalGate {
  private misses: ReadonlyMap<string, number> = new Map()

  /**
   * `hosted`: what the engine serves now; `present`: what this trusted read
   * names. Returns the ids to withdraw now, and the ids kept on a first miss.
   */
  judge(
    hosted: Iterable<string>,
    present: ReadonlySet<string>,
  ): { readonly withdraw: readonly string[]; readonly held: readonly string[] } {
    const withdraw: string[] = []
    const held: string[] = []
    const misses = new Map<string, number>()
    for (const id of hosted) {
      if (present.has(id)) continue
      const count = (this.misses.get(id) ?? 0) + 1
      if (count < WITHDRAWAL_CONFIRMATIONS) {
        held.push(id)
        misses.set(id, count)
      } else {
        withdraw.push(id)
      }
    }
    this.misses = misses
    return { withdraw, held }
  }
}

/** A device an engine built on a row it does not own. */
export interface HostedEngineDevice<D extends IDevice> {
  readonly device: D
  /** Run the device's own teardown, then unregister every native it registered. */
  withdraw(): Promise<void>
}

/**
 * Build `DeviceClass` on the composer's row `(stableId, id)`. The context is
 * `loadContext` (D677: a caller that BUILDS a device hydrates its stored
 * runtime state first); a kernel without it is refused by name rather than
 * building on an empty state. The device is never `register`ed and its config
 * never persisted: the row, its name and its lifetime are the composer's.
 */
export async function hostEngineDevice<D extends IDevice>(
  devices: DeviceManagerApi,
  row: ComposerDeviceRow,
  config: Record<string, unknown>,
  DeviceClass: DeviceConstructor<D>,
): Promise<HostedEngineDevice<D>> {
  if (devices.loadContext === undefined) {
    throw new Error(
      `this kernel cannot build a device on a row it does not own (no loadContext) — device ${String(row.id)} is not hosted`,
    )
  }
  const base = await devices.loadContext(row.stableId, row.id, null, config)
  const registered: string[] = []
  const context: DeviceContext = {
    ...base,
    registerNativeCap: (cap, provider) => {
      base.registerNativeCap(cap, provider)
      registered.push(cap.name)
    },
  }
  const device = new DeviceClass(context)
  return {
    device,
    withdraw: async () => {
      await device.removeDevice()
      for (const capName of registered) base.unregisterNativeCap?.(capName)
    },
  }
}
