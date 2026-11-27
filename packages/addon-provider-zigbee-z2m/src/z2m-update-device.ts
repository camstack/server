/**
 * The firmware of one Zigbee device as a `DeviceType.Update` device implementing `update`. Its status
 * is the `update` block the server pushes with the device's state (D224: nothing is polled), and
 * `installUpdate` starts the over-the-air update through the server. It is a sibling of the device
 * it updates, adopted on its own, never its parent.
 */
import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  type InferNativeProvider,
  updateCapability,
} from '@camstack/types'
import type { Z2mConnection } from './z2m-client.js'
import { ieeeOfUpdateEquipment, zigbeeUpdateSchema } from './z2m-device-config.js'
import { COLD_UPDATE_STATUS, startFirmwareUpdate, updateStatusOf } from './z2m-firmware.js'
import { z2mHub } from './z2m-hub.js'
import type { Z2mDevice, Z2mState } from './z2m-protocol.js'

export class ZigbeeUpdateDevice extends BaseDevice<typeof zigbeeUpdateSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string
  private readonly ieee: string
  private entry: Z2mDevice | null = null
  private linkOnline = false
  private bridgeOnline: boolean | null = null
  private unsubs: Array<() => void> = []

  constructor(ctx: DeviceContext) {
    super(ctx, zigbeeUpdateSchema, { type: ctx.deviceMeta.type })
    const values = this.config.values
    const ieee = ieeeOfUpdateEquipment(values.equipment)
    if (ieee === null)
      throw new Error(`zigbee2mqtt: ${values.equipment} is not an update device id`)
    this.integrationId = values.integrationId
    this.ieee = ieee
    const provider: InferNativeProvider<typeof updateCapability> = {
      getStatus: async () =>
        updateStatusOf(z2mHub.session(this.integrationId)?.stateOf(this.ieee)?.['update']),
      installUpdate: async () => {
        const session = z2mHub.session(this.integrationId)
        if (session === null) throw new Error('zigbee2mqtt: this integration has no connection')
        const name = this.entry?.friendly_name ?? this.ieee
        await startFirmwareUpdate(z2mHub, session, { ieee: this.ieee, name }, this.ctx.logger)
      },
    }
    this.ctx.registerNativeCap(updateCapability, provider)
    this.setCapSlice(updateCapability, COLD_UPDATE_STATUS)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.markOnline(false)
    z2mHub.bindDevice(this.integrationId, this.ieee, this.id)
    this.unsubs = [
      z2mHub.subscribeLink(this.integrationId, {
        connection: (state: Z2mConnection) => {
          this.linkOnline = state === 'online'
          this.syncOnline()
        },
        bridge: (_info, online) => {
          this.bridgeOnline = online
          this.syncOnline()
        },
        devices: () => {},
      }),
      z2mHub.subscribeDevice(this.integrationId, this.ieee, {
        device: (entry) => {
          this.entry = entry
        },
        state: (state: Z2mState) => {
          this.setCapSlice(updateCapability, updateStatusOf(state['update']))
        },
        availability: () => {},
      }),
    ]
  }

  private syncOnline(): void {
    this.markOnline(this.linkOnline && this.bridgeOnline !== false)
  }

  override async removeDevice(): Promise<void> {
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
    z2mHub.unbindDevice(this.integrationId, this.ieee, this.id)
    await super.removeDevice()
  }
}
