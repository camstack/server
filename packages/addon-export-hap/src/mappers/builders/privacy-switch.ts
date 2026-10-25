/**
 * Privacy-mask switch builder — turns the camstack `privacy-mask` cap's
 * global `enabled` state into a `Service.Switch` on the camera
 * accessory.
 *
 * iOS Home renders the switch as an inline control inside the camera
 * tile detail view. Toggling it sends `setMask({enabled})` to the
 * provider; the provider applies the camera-side mask
 * (Hikvision / Reolink both have a firmware-level toggle that disables
 * the streaming + recording pipelines when the mask is active).
 *
 * The Service uses a unique `subtype` so HAP serialises it separately
 * from any future Switch we add on the same accessory (e.g. a
 * camera-enabled switch — distinct from privacy-mask).
 */
import { Characteristic, Service } from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../types.js'
import { applyServiceLabel } from './service-label.js'
import { privacyServiceName } from './service-names.js'

interface PrivacyMaskStatusLike {
  readonly enabled?: boolean
}

export async function buildPrivacySwitch(bctx: BuilderContext): Promise<BuilderHandle> {
  const { ctx, accessory, proxy, numericDeviceId } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  // The label goes on BOTH `Name` and `ConfiguredName` — see
  // `service-label.ts` for why `Name` alone can never rename a service on an
  // already-paired controller.
  //
  // Just "Privacy": the switch is published on this camera's accessory and
  // iOS renders it there, so prefixing the camera name repeated the tile's
  // own title. See `service-names.ts`.
  const subtype = 'privacy-mask'
  const serviceName = privacyServiceName()
  const service = accessory.addService(Service.Switch, serviceName, subtype)
  applyServiceLabel(service, serviceName)

  try {
    const status = (await proxy.privacyMask?.getStatus({})) as PrivacyMaskStatusLike | null
    if (status && typeof status.enabled === 'boolean') {
      service.updateCharacteristic(Characteristic.On, status.enabled)
    }
  } catch (err) {
    log.debug('export-hap: privacy-mask getStatus hydrate failed (non-fatal)', {
      meta: { error: errMsg(err) },
    })
  }

  service.getCharacteristic(Characteristic.On).onSet(async (value) => {
    const enabled = value === true
    try {
      await proxy.privacyMask?.setMask({ patch: { enabled } })
    } catch (err) {
      log.warn('export-hap: privacy-mask setMask failed', {
        meta: { enabled, error: errMsg(err) },
      })
    }
  })

  const unsubscribes: Array<() => void> = []
  if (proxy.state.privacyMask) {
    const unsub = proxy.state.privacyMask.subscribe((value) => {
      const v = value as PrivacyMaskStatusLike | null
      if (v && typeof v.enabled === 'boolean') {
        service.updateCharacteristic(Characteristic.On, v.enabled)
      }
    })
    unsubscribes.push(unsub)
  }

  return {
    async dispose(): Promise<void> {
      for (const u of unsubscribes) {
        try {
          u()
        } catch {
          /* already gone */
        }
      }
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
