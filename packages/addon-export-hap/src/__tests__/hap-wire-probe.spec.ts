/**
 * The passive wire probe: HAP's own rejections and the stream-setup writes of a
 * camera accessory are visible at info, tagged with the device, and the probe
 * leaves no listener behind once disposed.
 */
import {
  Accessory,
  Characteristic,
  CharacteristicWarningType,
  Service,
} from '@homebridge/hap-nodejs'
import type { IScopedLogger, LogExtras, LogTags } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { buildHapWireProbe } from '../mappers/builders/hap-wire-probe.js'
import type { BuilderContext } from '../mappers/types.js'

interface Line {
  readonly msg: string
  readonly tags: LogTags
  readonly meta: LogExtras['meta']
}

function logger(sink: Line[], tags: LogTags = {}): IScopedLogger {
  const noop = (): void => {}
  return {
    debug: noop,
    info: (msg, extras) => {
      sink.push({ msg, tags, meta: extras?.meta })
    },
    warn: noop,
    error: noop,
    child: () => logger(sink, tags),
    withTags: (more) => logger(sink, { ...tags, ...more }),
  }
}

function setup() {
  const lines: Line[] = []
  const accessory = new Accessory('Front door', 'a3c9c3c0-0000-4000-8000-000000000615')
  const streaming = accessory.addService(Service.CameraRTPStreamManagement, 'stream', 'classic')
  // Documented type boundary: the probe reads only these three members of the builder context.
  const bctx = {
    accessory,
    numericDeviceId: 615,
    ctx: { logger: logger(lines) },
  } as unknown as BuilderContext
  return { lines, accessory, streaming, bctx }
}

describe('hap wire probe', () => {
  it('logs a HAP characteristic warning with its identity, tagged with the device', () => {
    const { lines, accessory, streaming, bctx } = setup()
    buildHapWireProbe(bctx, accessory)
    const characteristic = streaming.getCharacteristic(Characteristic.SetupEndpoints)

    accessory.emit('characteristic-warning', {
      characteristic,
      type: CharacteristicWarningType.WARN_MESSAGE,
      message: 'slow set handler',
      originatorChain: [],
    })

    const line = lines.find((l) => l.msg.includes('rejected or warned'))
    expect(line?.tags).toEqual({ deviceId: 615 })
    expect(line?.meta?.['characteristic']).toBe('Setup Endpoints')
    expect(line?.meta?.['message']).toBe('slow set handler')
  })

  it('logs a SetupEndpoints and a SelectedRTPStreamConfiguration write', () => {
    const { lines, accessory, streaming, bctx } = setup()
    buildHapWireProbe(bctx, accessory)

    streaming.getCharacteristic(Characteristic.SetupEndpoints).updateValue('AQID')
    streaming.getCharacteristic(Characteristic.SelectedRTPStreamConfiguration).updateValue('BAUG')

    const written = lines
      .filter((l) => l.msg.includes('wrote the stream setup'))
      .map((l) => l.meta?.['characteristic'])
    expect(written).toEqual(['SetupEndpoints', 'SelectedRTPStreamConfiguration'])
    expect(lines.every((l) => l.tags['deviceId'] === 615)).toBe(true)
  })

  it('leaves no listener behind once disposed', async () => {
    const { lines, accessory, streaming, bctx } = setup()
    const handle = buildHapWireProbe(bctx, accessory)
    await handle.dispose()

    streaming.getCharacteristic(Characteristic.SetupEndpoints).updateValue('AQID')
    expect(lines).toHaveLength(0)
    expect(accessory.listenerCount('characteristic-warning')).toBe(0)
  })
})
