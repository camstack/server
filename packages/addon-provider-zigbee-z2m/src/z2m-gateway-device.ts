/**
 * The Zigbee2MQTT server as a device: online while the frontend socket is up and the bridge reports
 * online. It is a SIBLING of the Zigbee devices, never their parent.
 */
import {
  BaseDevice,
  deviceMeshCapability,
  type DeviceContext,
  type DeviceFeature,
} from '@dominevo/types'
import { zigbeeGatewaySchema } from './z2m-device-config.js'
import type { Z2mConnection } from './z2m-client.js'
import { z2mHub } from './z2m-hub.js'
import { meshProviderFor } from './z2m-mesh.js'

export class ZigbeeGatewayDevice extends BaseDevice<typeof zigbeeGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  private linkOnline = false
  private bridgeOnline: boolean | null = null
  private unsub: (() => void) | null = null
  private coordinator: string | null = null

  constructor(ctx: DeviceContext) {
    super(ctx, zigbeeGatewaySchema, { type: ctx.deviceMeta.type })
    void this.updateSourceInfo({ id: 'gateway', system: 'zigbee2mqtt' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.markOnline(false)
    const integrationId = this.config.get('integrationId')
    this.ctx.registerNativeCap(deviceMeshCapability, meshProviderFor(z2mHub, integrationId))
    this.unsub = z2mHub.subscribeLink(integrationId, {
      connection: (state: Z2mConnection) => {
        this.linkOnline = state === 'online'
        this.sync()
      },
      bridge: (info, online) => {
        const coordinator = info?.coordinator?.ieee_address
        if (coordinator !== undefined) {
          this.coordinator = coordinator
          z2mHub.bindDevice(integrationId, coordinator, this.id)
        }
        this.bridgeOnline = online
        this.sync()
      },
      devices: () => {},
    })
  }

  override async removeDevice(): Promise<void> {
    this.unsub?.()
    this.unsub = null
    if (this.coordinator !== null) {
      z2mHub.unbindDevice(this.config.get('integrationId'), this.coordinator, this.id)
    }
    await super.removeDevice()
  }

  private sync(): void {
    this.markOnline(this.linkOnline && this.bridgeOnline !== false)
  }
}
