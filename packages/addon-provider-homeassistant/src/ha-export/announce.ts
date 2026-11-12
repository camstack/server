/**
 * The announce pass: every exported device's discovery payload, sent to each broker it reaches.
 *
 * Each broker gets its OWN `dev` block — the operator's Home Assistant name for that connection
 * (D1049), else the plan's — under the same device key, so a rename updates the same Home
 * Assistant device. A broker without a live link is skipped; a failed send is logged per device
 * and makes the pass report "not all delivered" so the next reconcile announces again.
 */
import type { IScopedLogger } from '@camstack/types'
import { devBlockFor } from './exposed-name.js'
import type { HaCmps, HaDeviceBlock, HaDevicePlan } from './types.js'

/** What the announce reads of an exported device. */
export interface AnnounceEntry {
  readonly deviceId: number
  readonly brokerIds: readonly string[]
  readonly plan: Pick<HaDevicePlan, 'deviceKey' | 'cmps' | 'dev'>
  readonly exposedNames?: ReadonlyMap<string, string>
}

/** One broker's discovery sender (the push client's `publishEntityChange`). */
export interface AnnounceClient {
  publishEntityChange(
    deviceKey: string,
    cmps: HaCmps,
    dev: HaDeviceBlock,
    full: boolean,
  ): Promise<boolean>
}

/** Announce every entry to each of its brokers; `true` only when every send was delivered. */
export async function announceToBrokers(
  entries: Iterable<AnnounceEntry>,
  clientFor: (brokerId: string) => AnnounceClient | undefined,
  full: boolean,
  logger: IScopedLogger,
): Promise<boolean> {
  let allDelivered = true
  for (const entry of entries) {
    for (const brokerId of entry.brokerIds) {
      const client = clientFor(brokerId)
      if (client === undefined) continue
      try {
        const ok = await client.publishEntityChange(
          entry.plan.deviceKey,
          entry.plan.cmps,
          devBlockFor(entry.plan.dev, entry.exposedNames, brokerId),
          full,
        )
        if (!ok) allDelivered = false
      } catch (err) {
        allDelivered = false
        logger.warn('ha-export: could not announce a device, skipping it', {
          tags: { deviceId: entry.deviceId },
          meta: { brokerId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }
  return allDelivered
}
