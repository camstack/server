/**
 * `action.devices.QUERY` — Google asks for current state.
 *
 * This intent carries more weight here than in a normal integration: because
 * the addon declares `willReportState: false` (it holds no HomeGraph
 * credential and pushes nothing), QUERY is the ONLY way Google ever learns a
 * device changed. Every branch therefore answers with a device entry — Google
 * treats a missing key as a protocol error, not as "unknown".
 *
 * The exposed-list check is a security gate, not a convenience: without it a
 * linked Google account could read the state of any device id it guessed,
 * including ones the operator never exported.
 */
import type { IScopedLogger } from '@camstack/types'

import type { DeviceGateway } from '../device-gateway.js'
import type { QueryDeviceState, QueryInput, QueryResponsePayload } from '../google-home/protocol.js'
import { traitsForCaps } from '../google-home/trait-catalog.js'
import { mapWithConcurrency } from '../lib/concurrency.js'

const QUERY_READ_CONCURRENCY = 6

export interface QueryDeps {
  readonly gateway: DeviceGateway
  readonly logger: IScopedLogger
  readonly isExposed: (deviceId: number) => boolean
}

const NOT_FOUND: QueryDeviceState = {
  online: false,
  status: 'ERROR',
  errorCode: 'deviceNotFound',
}

const OFFLINE: QueryDeviceState = { online: false, status: 'OFFLINE' }

export async function handleQuery(
  input: QueryInput,
  deps: QueryDeps,
): Promise<QueryResponsePayload> {
  const requested = input.payload.devices.map((device) => device.id)

  const answers = await mapWithConcurrency(requested, QUERY_READ_CONCURRENCY, async (rawId) => {
    const state = await queryOne(rawId, deps)
    return [rawId, state] as const
  })

  const devices: Record<string, QueryDeviceState> = {}
  for (const [id, state] of answers) devices[id] = state
  return { devices }
}

async function queryOne(rawId: string, deps: QueryDeps): Promise<QueryDeviceState> {
  const deviceId = Number.parseInt(rawId, 10)
  if (!Number.isFinite(deviceId)) {
    deps.logger.warn('google query: refused — device id is not numeric', {
      meta: { requestedId: rawId },
    })
    return NOT_FOUND
  }
  if (!deps.isExposed(deviceId)) {
    deps.logger.warn('google query: refused — device is not exposed to Google', {
      tags: { deviceId },
    })
    return NOT_FOUND
  }

  const facts = await deps.gateway.loadFacts(deviceId).catch((err: unknown) => {
    deps.logger.warn('google query: registry read failed', {
      tags: { deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  })
  if (facts === null) return NOT_FOUND

  const descriptors = traitsForCaps(facts.capNames)
  if (descriptors.length === 0) {
    deps.logger.warn('google query: device has no exported capability', {
      tags: { deviceId },
      meta: { capNames: facts.capNames },
    })
    return NOT_FOUND
  }

  const fields: Record<string, unknown> = {}
  let anyRead = false
  for (const descriptor of descriptors) {
    const raw = await deps.gateway.readStatus(descriptor.reads, deviceId).catch((err: unknown) => {
      deps.logger.warn('google query: capability status read failed', {
        tags: { deviceId },
        meta: { cap: descriptor.capName, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    })
    const projected = descriptor.projectState(raw)
    if (projected === null) {
      // Either the provider answered `null` (device unreachable) or the payload
      // did not match the cap's own status schema. Both mean "we do not know",
      // and both are logged — a state Google shows as stale with no trace here
      // is the failure this line exists to prevent.
      deps.logger.warn('google query: no usable state for capability', {
        tags: { deviceId },
        meta: { cap: descriptor.capName },
      })
      continue
    }
    anyRead = true
    Object.assign(fields, projected)
  }

  if (!anyRead) return OFFLINE
  return { online: true, status: 'SUCCESS', ...fields }
}
