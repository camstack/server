/**
 * The Zigbee2MQTT server as a device: online while the frontend socket is up and the bridge reports
 * online. It is a SIBLING of the Zigbee devices, never their parent.
 */
import { BaseDevice, type DeviceContext, type DeviceFeature } from '@camstack/types'
import { zigbeeGatewaySchema } from './z2m-device-config.js'
import type { Z2mConnection } from './z2m-client.js'
import { z2mHub } from './z2m-hub.js'

export class ZigbeeGatewayDevice extends BaseDevice<typeof zigbeeGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  private linkOnline = false
  private bridgeOnline: boolean | null = null

  constructor(ctx: DeviceContext) {
    super(ctx, zigbeeGatewaySchema, { type: ctx.deviceMeta.type })
    void this.updateSourceInfo({ id: 'gateway', system: 'zigbee2mqtt' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.markOnline(false)
    z2mHub.subscribeLink(this.config.get('integrationId'), {
      connection: (state: Z2mConnection) => {
        this.linkOnline = state === 'online'
        this.sync()
      },
      bridge: (_info, online) => {
        this.bridgeOnline = online
        this.sync()
      },
      devices: () => {},
    })
  }

  private sync(): void {
    this.markOnline(this.linkOnline && this.bridgeOnline !== false)
  }
}
