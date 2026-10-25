import type { IScopedLogger } from '@camstack/types'
import type { Mapper } from './mappers/types.js'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Surface the `X-HM://…` pairing URI of the first standalone accessory
 * the addon currently has published.
 *
 * Each HomeKit accessory carries its own URI even though the pincode is
 * shared across every accessory the addon publishes — the URI bakes in
 * per-accessory category + setupID bits. The `device-export` cap status
 * panel renders ONE QR; that QR pairs the first exposed camera and the
 * operator adds the rest from iOS Home → + → Add Accessory with the
 * same pincode.
 *
 * Returns `undefined` when no accessory has been exposed yet (the panel
 * then renders the pincode + a note alone) or when `setupURI()` throws
 * (rare — only meaningful after `publishStandalone` has loaded the
 * accessory's identity). Failures log at debug; the panel never crashes
 * on a missing QR.
 */
export function firstExposedAccessorySetupUri(
  exposed: ReadonlyMap<string, Mapper>,
  logger: IScopedLogger,
): string | undefined {
  for (const mapper of exposed.values()) {
    const first = mapper.accessories[0]
    if (!first) continue
    try {
      return first.setupURI()
    } catch (err) {
      logger.debug('export-hap: setupURI failed on first exposed accessory', {
        meta: { error: errMsg(err) },
      })
      return undefined
    }
  }
  return undefined
}
