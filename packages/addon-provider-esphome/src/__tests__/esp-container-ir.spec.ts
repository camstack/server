import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRole, DeviceType } from '@camstack/types'
import { EspContainerDevice } from '../devices/esp-container-device.js'
import { EspIrTransmitterDevice } from '../devices/esp-ir-transmitter-device.js'
import { espIrOverrides } from '../esphome-ir-overrides.js'
import { parseIrServices } from '../esphome-ir-plan.js'
import { espLinkHub } from '../esphome-link-hub.js'
import { FakeLink, entity } from './fake-link.js'
import { makeCtx } from './fake-ctx.js'

const BROKER = 'esp_container_ir'

function board(): FakeLink {
  const link = new FakeLink([entity({ id: 'switch-relay', type: 'switch', name: 'Relay' })])
  link.services = [
    { name: 'send_raw_command', key: 1, args: [{ name: 'command', type: 'int[]' }] },
    { name: 'send_rf', key: 2, args: [{ name: 'code', type: 'int[]' }] },
    { name: 'reboot', key: 3, args: [] },
  ]
  return link
}

function container(): EspContainerDevice {
  const { ctx } = makeCtx({ brokerId: BROKER, system: 'esphome', integrationId: 'int-1' })
  return new EspContainerDevice(ctx)
}

afterEach(() => {
  espLinkHub.clear()
  espIrOverrides.clear()
})

describe('EspContainerDevice transmitter children', () => {
  it('gives every qualifying API service a transmitter child beside the entity children', () => {
    espLinkHub.attach(BROKER, board())
    const specs = container().getAccessoryChildren()
    expect(specs.map((s) => s.stableIdSuffix)).toEqual([
      'switch-relay',
      'svc:send_raw_command',
      'svc:send_rf',
    ])
    const ir = specs.find((s) => s.stableIdSuffix === 'svc:send_raw_command')
    expect(ir?.meta).toMatchObject({
      type: DeviceType.Generic,
      name: 'send_raw_command',
      role: String(DeviceRole.IrTransmitter),
      integrationId: 'int-1',
      linkDeviceId: 7,
    })
    expect(ir?.config).toMatchObject({
      brokerId: BROKER,
      service: 'send_raw_command',
      timingsArg: 'command',
      media: ['ir'],
    })
  })

  it('builds an EspIrTransmitterDevice for the child', () => {
    espLinkHub.attach(BROKER, board())
    const ir = container()
      .getAccessoryChildren()
      .find((s) => s.stableIdSuffix === 'svc:send_raw_command')
    const { ctx } = makeCtx(ir?.config ?? {}, { type: DeviceType.Generic })
    expect(ir?.factory(ctx)).toBeInstanceOf(EspIrTransmitterDevice)
  })

  it('follows the per-board irServices override', () => {
    espLinkHub.attach(BROKER, board())
    const dev = container()
    espIrOverrides.set(dev.id, parseIrServices([{ name: 'send_rf', medium: 'rf' }]) ?? 'auto')
    const specs = dev.getAccessoryChildren()
    expect(specs.map((s) => s.stableIdSuffix)).toEqual(['switch-relay', 'svc:send_rf'])
    expect(specs[1]?.config).toMatchObject({ media: ['rf'] })
  })

  it('an empty override removes every transmitter, entity children stay', () => {
    espLinkHub.attach(BROKER, board())
    const dev = container()
    espIrOverrides.set(dev.id, parseIrServices([]) ?? 'auto')
    expect(dev.getAccessoryChildren().map((s) => s.stableIdSuffix)).toEqual(['switch-relay'])
  })

  it('spawns nothing while the board is unreachable', () => {
    expect(container().getAccessoryChildren()).toEqual([])
  })
})
