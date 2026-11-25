/**
 * A device's `Alexa.EndpointHealth.connectivity`, from the device-status slice
 * every device carries (`device-status`, D770).
 *
 * A read that FAILS answers `OK`. The failure is ours — a provider respawning,
 * a busy hub — and saying UNREACHABLE would make the phone app refuse a live
 * view that would most likely work; saying OK costs, at worst, one directive
 * that then fails with its own error. The failure is logged.
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { z } from 'zod'

/** The one field read off the `device-status` slice (its wire output is
 *  untyped here). */
const OnlineSchema = z.object({ online: z.boolean(), unknown: z.literal(true).optional() })

export type AlexaConnectivity = 'OK' | 'UNREACHABLE'

export async function readConnectivity(
  api: AddonApi,
  deviceId: number,
  logger: IScopedLogger,
): Promise<AlexaConnectivity> {
  try {
    const parsed = OnlineSchema.safeParse(await api.deviceStatus.getStatus.query({ deviceId }))
    // `unknown` (D1099) is the provider not having answered since a restart:
    // not a claim of unreachability, so it answers OK like a failed read does.
    return parsed.success && !parsed.data.online && parsed.data.unknown !== true
      ? 'UNREACHABLE'
      : 'OK'
  } catch (err) {
    logger.debug('alexa: device-status unreadable — reporting connectivity OK', {
      tags: { deviceId },
      meta: { error: errMsg(err) },
    })
    return 'OK'
  }
}
