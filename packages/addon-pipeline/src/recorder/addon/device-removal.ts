/**
 * The recorder's `device-removal-hook` implementation (D865): when a device is
 * deleted its footage goes with it, now, instead of
 * waiting for retention or for disk pressure to find the orphan.
 *
 * ## Footage
 *
 * Selected from the ARCHIVE (the durable hour ledger), never from the resident
 * index (D295): the index holds the live tail only, and a delete driven by it
 * leaves most of a camera behind while reporting success. Each pass takes at
 * most {@link PRUNE_MAX_SEGMENTS_PER_PASS} segments and evicts them through the
 * same `SegmentStore` path retention and quota use, location by location, so a
 * failing location is logged and does not stop the others. Passes repeat until
 * the archive holds nothing for the camera. A camera that STILL has footage
 * after the bounded passes (a frozen or unreadable location) throws, so the
 * caller retries instead of believing it is clean. The audit row carries
 * `reason: 'orphaned-device'`.
 *
 * ## What is deliberately not here
 *
 * The audit rows of the camera stay (they are the answer to "what happened to
 * the footage"), and nothing is inferred from a camera's absence: the caller
 * only invokes this for a recorded delete or an operator-confirmed clean-up.
 */
import type {
  DeviceDataEntry,
  DeviceRemovedInput,
  DeviceRemovedResult,
  IDeviceRemovalHookProvider,
} from '@camstack/types'
import { PRUNE_MAX_SEGMENTS_PER_PASS } from '../evict-select.js'
import type { SegmentRow } from '../types.js'
import { evictVictims, type RecordingProviderDeps } from './recording-provider.js'

/** Passes before a camera with footage left is reported as not clean. */
export const REMOVAL_MAX_PASSES = 200

interface FootageTotals {
  readonly deletedBuckets: number
  readonly reclaimedBytes: number
}

async function nextVictims(
  deps: RecordingProviderDeps,
  deviceId: number,
): Promise<readonly SegmentRow[] | null> {
  const archive = deps.archive?.() ?? null
  if (archive === null) return null
  const victims: SegmentRow[] = []
  for await (const page of archive.streamSegments({ deviceId })) {
    victims.push(...page)
    if (victims.length >= PRUNE_MAX_SEGMENTS_PER_PASS) break
  }
  return victims
}

/** Delete every segment the archive holds for `deviceId`, across every location of this node. */
export async function purgeDeviceFootage(
  deps: RecordingProviderDeps,
  deviceId: number,
): Promise<FootageTotals> {
  let deletedBuckets = 0
  let reclaimedBytes = 0
  for (let pass = 0; pass < REMOVAL_MAX_PASSES; pass++) {
    const victims = await nextVictims(deps, deviceId)
    if (victims === null) {
      // No ledger: the resident index is not the archive, and a delete over it
      // would leave footage behind while saying it was clean. Retry later.
      throw new Error('no durable hour ledger on this node — footage cannot be enumerated')
    }
    if (victims.length === 0) break
    const freed = await evictVictims(deps, deviceId, victims)
    deletedBuckets += freed.deletedBuckets
    reclaimedBytes += freed.reclaimedBytes
    if (freed.deletedBuckets === 0) break
  }
  const census = await deps.archive?.()?.census({ deviceId })
  if (census === null || census === undefined || census.segments > 0) {
    throw new Error(
      `footage of device ${deviceId} is not fully removed (${census?.segments ?? 'unknown'} segments left)`,
    )
  }
  if (deletedBuckets > 0) {
    await deps.opsLog?.append({
      op: 'prune',
      reason: 'orphaned-device',
      deviceId,
      itemsAffected: deletedBuckets,
      bytesReclaimed: reclaimedBytes,
      detail: 'the device was deleted — its footage was removed with it',
    })
  }
  return { deletedBuckets, reclaimedBytes }
}

export function createRecorderRemovalHook(deps: RecordingProviderDeps): IDeviceRemovalHookProvider {
  const removeDevice = async (input: DeviceRemovedInput): Promise<DeviceRemovedResult> => {
    const { deviceId } = input
    const footage = await purgeDeviceFootage(deps, deviceId)
    const counts = { footage: footage.deletedBuckets }
    if (footage.deletedBuckets > 0) {
      deps.logger.info('recorder: removed the data of a deleted device', {
        tags: { deviceId },
        meta: { counts, reclaimedBytes: footage.reclaimedBytes, deletedAt: input.deletedAt },
      })
    }
    return { counts }
  }
  return {
    onDeviceRemoved: removeDevice,
    listDeviceData: async (): Promise<readonly DeviceDataEntry[]> => {
      const out: DeviceDataEntry[] = []
      const locationIds = new Set(deps.locations().map((l) => l.id))
      const usage = deps.archiveDeviceUsage?.(locationIds) ?? null
      if (usage === null) {
        throw new Error('no durable hour ledger on this node — footage cannot be enumerated')
      }
      for (const [deviceId, u] of usage) {
        if (u.segments > 0) out.push({ store: 'footage', deviceId, count: u.segments })
      }
      return out
    },
  }
}
