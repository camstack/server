/**
 * `action.devices.SYNC` — Google asks what the linked account owns.
 *
 * Every device comes from the operator-curated exposed list resolved against
 * the LIVE registry, so an exposed-but-deleted device is dropped rather than
 * returned as a zombie Google will keep showing forever (Google's copy of the
 * device list is refreshed by nothing except our SYNC answer).
 *
 * Three drop branches, and all three LOG with `tags: { deviceId }`. A device
 * that quietly fails to appear in the Home app is the hardest failure to
 * diagnose in this addon — there is no error anywhere, just an absence.
 */
import type { IScopedLogger } from '@camstack/types'

import type { DeviceGateway } from '../device-gateway.js'
import { buildSyncDevice } from '../google-home/device-model.js'
import type { SyncDevice, SyncResponsePayload } from '../google-home/protocol.js'
import { mapWithConcurrency } from '../lib/concurrency.js'

/** Devices resolved at once. Each is two latency-bound tRPC reads
 *  (`getDevice` + `getBindings`); a serial loop makes SYNC scale linearly in
 *  fleet size, which Alexa's discovery already measured in minutes. */
const SYNC_BUILD_CONCURRENCY = 6

export interface SyncDeps {
  readonly gateway: DeviceGateway
  readonly logger: IScopedLogger
  /** Operator-curated exposed device ids, read from the addon's own store. */
  readonly listExposed: () => readonly number[]
}

export async function handleSync(
  agentUserId: string,
  deps: SyncDeps,
): Promise<SyncResponsePayload> {
  const exposed = deps.listExposed()

  const built = await mapWithConcurrency(exposed, SYNC_BUILD_CONCURRENCY, async (deviceId) => {
    const facts = await deps.gateway.loadFacts(deviceId).catch((err: unknown) => {
      deps.logger.warn('google sync: skipping device — registry read failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    })
    if (facts === null) {
      deps.logger.warn('google sync: skipping device — not in the live registry', {
        tags: { deviceId },
      })
      return null
    }
    const device = buildSyncDevice(facts)
    if (device === null) {
      deps.logger.warn('google sync: skipping device — no exported capability', {
        tags: { deviceId },
        meta: { deviceType: facts.deviceType, capNames: facts.capNames },
      })
      return null
    }
    return device
  })

  const devices: readonly SyncDevice[] = built.filter(
    (device): device is SyncDevice => device !== null,
  )

  deps.logger.info('google sync: answered', {
    meta: { exposed: exposed.length, returned: devices.length, agentUserId },
  })

  return { agentUserId, devices }
}
