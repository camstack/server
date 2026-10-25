/**
 * One-shot boot backfill for D356: the `auto` link mode is retired, and a
 * camera that never chose `manual` was linked by location until today.
 *
 * A rule an operator relied on cannot vanish on an update — a notification
 * that named a linked siren, a tracked-event source — so what `auto`
 * resolved is written ONCE into the camera's manual list, and the operator
 * PRUNES from the picker instead of discovering an absence. A camera that
 * already said `manual` is left exactly as it is. Runs under a version
 * marker in the addon store, like the location backfill it sits next to.
 */
import type { LinkCandidate } from './device-linked-devices.js'
import {
  LINK_CANDIDATE_PROJECTION,
  LINKED_IDS_CONFIG_KEY,
  LINKED_MODE_CONFIG_KEY,
  legacyAutoLinkIds,
  parseLinkedDevicesConfig,
} from './device-linked-devices.js'
import type { ProviderContext } from './device-provider-context.js'
import { listAll } from './device-queries.js'
import { DeviceType } from '@camstack/types'

export const LINKED_MANUAL_BACKFILL_MARKER_KEY = '_linkedDevicesManualBackfillVersion'
export const LINKED_MANUAL_BACKFILL_VERSION = 1

export interface ManualBackfillPlan {
  /** `false` = the camera was already on `manual`; nothing to write. */
  readonly write: boolean
  readonly manualIds: readonly number[]
}

export function planManualBackfill(params: {
  readonly selfId: number
  readonly selfLocation: string | null
  readonly blob: Record<string, unknown>
  readonly candidates: readonly LinkCandidate[]
}): ManualBackfillPlan {
  const { selfId, selfLocation, blob, candidates } = params
  const current = parseLinkedDevicesConfig(blob).manualIds
  if (blob[LINKED_MODE_CONFIG_KEY] === 'manual') return { write: false, manualIds: current }
  const merged = [...current]
  for (const id of legacyAutoLinkIds({ selfId, selfLocation, candidates })) {
    if (!merged.includes(id)) merged.push(id)
  }
  return { write: true, manualIds: merged }
}

export async function runLinkedDevicesManualBackfillAtBoot(pctx: ProviderContext): Promise<void> {
  const logger = pctx.host.ctx.logger
  const addonStore = await pctx.settings.readAddonStore()
  const markerRaw = addonStore[LINKED_MANUAL_BACKFILL_MARKER_KEY]
  const completed = typeof markerRaw === 'number' ? markerRaw : 0
  if (completed >= LINKED_MANUAL_BACKFILL_VERSION) return

  // The same slim projection the resolver reads — the candidates ARE the fleet.
  const all = await listAll(pctx, LINK_CANDIDATE_PROJECTION)
  let written = 0
  let linked = 0
  for (const cam of all) {
    if (cam.type !== DeviceType.Camera) continue
    const blob = await pctx.settings.readDeviceStore(cam.id)
    const plan = planManualBackfill({
      selfId: cam.id,
      selfLocation: cam.location ?? null,
      blob,
      candidates: all,
    })
    if (!plan.write) continue
    await pctx.settings.writeDeviceStore(cam.id, {
      ...blob,
      [LINKED_MODE_CONFIG_KEY]: 'manual',
      [LINKED_IDS_CONFIG_KEY]: [...plan.manualIds],
    })
    written += 1
    linked += plan.manualIds.length
    logger.info('linked devices: auto links materialised into the manual list (D356)', {
      tags: { deviceId: cam.id },
      meta: { manualIds: plan.manualIds },
    })
  }
  await pctx.settings.writeAddonStore({
    ...addonStore,
    [LINKED_MANUAL_BACKFILL_MARKER_KEY]: LINKED_MANUAL_BACKFILL_VERSION,
  })
  logger.info('linked devices: manual backfill complete (D356)', {
    meta: { camerasWritten: written, linksMaterialised: linked },
  })
}
