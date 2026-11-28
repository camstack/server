/**
 * Firmware update of one Zigbee device, shared by the integration action and the Update device.
 * An update runs for minutes and Zigbee2MQTT answers the request only when it is over, so a start
 * answers once the server has accepted it; a refusal that arrives inside the window is thrown.
 */
import type { IScopedLogger, UpdateStatus } from '@dominevo/types'
import { errMsg } from '@dominevo/types'
import type { Z2mHub } from './z2m-hub.js'
import { type Z2mUpdateState, Z2mUpdateStateSchema } from './z2m-protocol.js'
import type { Z2mSession } from './z2m-session.js'

/** An update runs until the device has taken the image: minutes, up to an hour on a slow sleepy node. */
export const Z2M_OTA_UPDATE_TIMEOUT_MS = 60 * 60_000
/** How long a refusal may take to arrive before the update counts as accepted. */
export const Z2M_OTA_ACCEPT_WINDOW_MS = 3_000

export type Delay = (ms: number) => Promise<void>

export const realDelay: Delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export interface FirmwareTarget {
  readonly ieee: string
  readonly name: string
}

/** Start the update. Resolves once it is accepted; rejects with the server's reason when it refuses. */
export async function startFirmwareUpdate(
  hub: Z2mHub,
  session: Z2mSession,
  target: FirmwareTarget,
  logger: IScopedLogger,
  delay: Delay = realDelay,
): Promise<{ readonly finished: boolean }> {
  const deviceId = hub.deviceIdOf(session.integrationId, target.ieee)
  const tags = deviceId === null ? undefined : { deviceId }
  const running = session.request(
    'bridge/request/device/ota_update/update',
    { id: target.ieee },
    Z2M_OTA_UPDATE_TIMEOUT_MS,
  )
  // A refusal arrives at once; an update that is going ahead answers only when it is over.
  const outcome = await Promise.race([
    running.then(
      () => 'done' as const,
      (err: unknown) => err,
    ),
    delay(Z2M_OTA_ACCEPT_WINDOW_MS).then(() => 'running' as const),
  ])
  if (outcome === 'done') return { finished: true }
  if (outcome !== 'running') throw outcome instanceof Error ? outcome : new Error(String(outcome))
  void running.then(
    () =>
      logger.info('zigbee2mqtt: firmware update finished', { tags, meta: { device: target.name } }),
    (err: unknown) =>
      logger.warn('zigbee2mqtt: firmware update failed', {
        tags,
        meta: { device: target.name, reason: errMsg(err) },
      }),
  )
  return { finished: false }
}

export const COLD_UPDATE_STATUS: UpdateStatus = {
  currentVersion: null,
  availableVersion: null,
  updatable: false,
  state: null,
  inProgress: false,
}

/** The `update` capability's status from the `update` block the server pushes with a device's state. */
export function updateStatusOf(block: unknown): UpdateStatus {
  const parsed = Z2mUpdateStateSchema.safeParse(block)
  if (!parsed.success) return COLD_UPDATE_STATUS
  const u: Z2mUpdateState = parsed.data
  const installed = u.installed_version ?? null
  const latest = u.latest_version ?? null
  return {
    currentVersion: installed === null ? null : String(installed),
    availableVersion: latest === null ? null : String(latest),
    updatable:
      u.state === 'available' || (installed !== null && latest !== null && latest > installed),
    state: u.state,
    inProgress: u.state === 'updating' || u.state === 'scheduled',
  }
}
