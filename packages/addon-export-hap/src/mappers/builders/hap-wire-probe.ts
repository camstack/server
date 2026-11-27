/**
 * A passive probe of what HomeKit does to a camera accessory BEFORE our streaming
 * delegate hears of it. A long-press on a doorbell notification left no
 * `stream prepared` / `prepareStream failed` line at all, so nothing said whether
 * iOS never wrote the stream setup, or HAP-NodeJS refused it first.
 *
 * Two listeners, neither of which can alter a request:
 *  - the accessory's `characteristic-warning` event (a read or write HAP-NodeJS
 *    complained about or rejected) - one info line each;
 *  - the `change` event of the streaming service's `SetupEndpoints` and
 *    `SelectedRTPStreamConfiguration` characteristics, which fires after a
 *    controller's write landed - one info line each.
 * No `set` handler is touched: the controller owns it, and a second one would
 * replace or break it.
 */
import { Characteristic, type Accessory, Service } from '@homebridge/hap-nodejs'
import type { BuilderContext, BuilderHandle } from '../types.js'

const WATCHED_WRITES: ReadonlyArray<{ readonly uuid: string; readonly name: string }> = [
  { uuid: Characteristic.SetupEndpoints.UUID, name: 'SetupEndpoints' },
  {
    uuid: Characteristic.SelectedRTPStreamConfiguration.UUID,
    name: 'SelectedRTPStreamConfiguration',
  },
]

export function buildHapWireProbe(bctx: BuilderContext, accessory: Accessory): BuilderHandle {
  const log = bctx.ctx.logger.withTags({ deviceId: bctx.numericDeviceId })
  const disposers: Array<() => void> = []

  const onWarning = (warning: {
    readonly characteristic: Characteristic
    readonly message: string
    readonly type: string
  }): void => {
    log.info('export-hap: HAP rejected or warned on a characteristic request', {
      meta: {
        aid: accessory.aid ?? null,
        iid: warning.characteristic.iid ?? null,
        characteristic: warning.characteristic.displayName,
        uuid: warning.characteristic.UUID,
        status: warning.type,
        message: warning.message,
      },
    })
  }
  accessory.on('characteristic-warning', onWarning)
  disposers.push(() => accessory.off('characteristic-warning', onWarning))

  for (const service of accessory.services) {
    if (service.UUID !== Service.CameraRTPStreamManagement.UUID) continue
    for (const watched of WATCHED_WRITES) {
      const characteristic = service.characteristics.find((c) => c.UUID === watched.uuid)
      if (characteristic === undefined) continue
      const onChange = (): void => {
        log.info('export-hap: HomeKit wrote the stream setup', {
          meta: {
            aid: accessory.aid ?? null,
            iid: characteristic.iid ?? null,
            characteristic: watched.name,
            streamingService: service.subtype ?? null,
          },
        })
      }
      characteristic.on('change', onChange)
      disposers.push(() => characteristic.off('change', onChange))
    }
  }

  return {
    async dispose(): Promise<void> {
      for (const dispose of disposers) dispose()
    },
  }
}
