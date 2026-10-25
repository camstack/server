import { DeviceType, errMsg, type IScopedLogger } from '@camstack/types'
import type { HomeConnectChildReconciler } from './home-connect-child-reconciler.js'

/** The slice of a device the tracker reads. */
export interface HomeConnectTrackableDevice {
  readonly id: number
  readonly type: DeviceType
}

export interface HomeConnectContainerTrackerDeps {
  /** This addon's devices — `ctx.kernel.devices.getAll()`, which a forked runner serves too. */
  readonly listDevices: () => Promise<readonly HomeConnectTrackableDevice[]>
  readonly loadConfig: (deviceId: number) => Promise<Record<string, unknown>>
  readonly reconciler: Pick<HomeConnectChildReconciler, 'track' | 'tracks'>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

/**
 * Put a reconciler watch on every adopted appliance container not watched yet. Called at
 * init, on connect, on adopt AND after the device restore — in a forked runner the devices
 * are restored only after `onInitialize` returns, so a pass at init sees none of them and
 * the containers were never watched: a description that arrived later derived no children.
 * Returns how many containers it started watching.
 */
export async function trackHomeConnectContainers(
  deps: HomeConnectContainerTrackerDeps,
  trigger: string,
): Promise<number> {
  let started = 0
  let devices: readonly HomeConnectTrackableDevice[]
  try {
    devices = await deps.listDevices()
  } catch (err: unknown) {
    deps.logger.warn('Home Connect could not list its devices to watch their children', {
      meta: { trigger, error: errMsg(err) },
    })
    return 0
  }
  for (const d of devices) {
    if (d.type !== DeviceType.Container || deps.reconciler.tracks(d.id)) continue
    const cfg = await deps.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    const brokerId = cfg['brokerId']
    const haId = cfg['haId']
    if (cfg['system'] !== 'home-connect' || typeof brokerId !== 'string') continue
    if (typeof haId !== 'string') continue
    deps.reconciler.track({ deviceId: d.id, brokerId, haId })
    started += 1
    deps.logger.info('Home Connect watching appliance children', {
      tags: { deviceId: d.id, integrationId: brokerId },
      meta: { haId, trigger },
    })
  }
  return started
}
