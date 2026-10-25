/**
 * The ONE builder every read-only sensor row goes through.
 *
 * There is no per-sensor builder file and there must not be one: a contact, a
 * leak and a thermometer differ only in which service they add and which field
 * they read, and both of those are data — see `cap-service-table.ts`. Anything
 * a sensor needs beyond that (a write path, a mode, a refusal) is not a sensor
 * and gets its own row builder.
 */
import type { BuilderContext, BuilderHandle } from '../../types.js'
import { hapServiceName } from '../service-names.js'
import { applyServiceLabel } from '../service-label.js'
import { applyUpdates } from './characteristic-update.js'
import type { HapSensorSpec } from './cap-service-table.js'

export interface SensorServiceInput {
  readonly bctx: BuilderContext
  readonly spec: HapSensorSpec
  /** Label to publish — already device-derived, not yet HAP-sanitised. */
  readonly name: string
  /** Stable service subtype so HAP serialisation round-trips. */
  readonly subtype: string
}

export async function buildSensorService(input: SensorServiceInput): Promise<BuilderHandle> {
  const { bctx, spec, name, subtype } = input
  const { ctx, accessory, proxy, numericDeviceId } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  const label = hapServiceName([name], spec.label)
  const service = spec.addService(accessory, label, subtype)
  applyServiceLabel(service, label)

  const apply = (status: unknown, source: string): void => {
    const updates = spec.read(status)
    if (updates.length === 0) {
      // The drop is logged rather than swallowed: a status that does not match
      // the cap's schema leaves the characteristic frozen at its last value,
      // which in the Home app is indistinguishable from a quiet sensor.
      log.debug('export-hap: sensor status did not match the cap schema — no update', {
        meta: { subtype, source },
      })
      return
    }
    applyUpdates(service, updates)
  }

  try {
    const status = await spec.getStatus(proxy)
    if (status !== undefined && status !== null) apply(status, 'getStatus')
  } catch (err) {
    log.debug('export-hap: sensor getStatus hydrate failed (non-fatal)', {
      meta: { subtype, error: errMsg(err) },
    })
  }

  const unsubscribe = spec.subscribe(proxy, (value) => {
    if (value === undefined || value === null) return
    apply(value, 'slice')
  })

  return {
    async dispose(): Promise<void> {
      try {
        unsubscribe?.()
      } catch {
        /* already gone */
      }
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
