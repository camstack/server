import {
  BaseDevice,
  buildDeviceAdminUrl,
  type DeviceContext,
  type DeviceFeature,
  DeviceType,
  deviceAdminLinkCapability,
  errMsg,
  type InferNativeProvider,
} from '@camstack/types'
import { homematicGatewayDeviceSchema } from '../config.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { gatewayMetadataPatch } from '../homematic-gateway-metadata.js'

/**
 * The physical CCU3 / RaspberryMatic box, as a {@link DeviceType.Gateway}. Its
 * connection and password live on the INTEGRATION; this device follows whether
 * the session is up, carries the box's host as metadata and offers the one
 * action the library really supports through an existing cap:
 *
 * - `device-admin-link`, the CCU's own WebUI.
 *
 * There is no `reboot` and no `update`: nodehomematic has no call that restarts
 * the CCU, and its firmware call installs an update on a radio DEVICE by its
 * address, never on the box, so neither is advertised.
 *
 * Products are NOT children of the gateway; they are adopted as their own
 * top-level devices of the same integration.
 */
export class HomematicGatewayDevice extends BaseDevice<typeof homematicGatewayDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string
  private snapshotUnsub: (() => void) | null = null
  /** The last metadata written, so a state change that altered nothing writes nothing. */
  private lastMetadataKey = ''

  constructor(ctx: DeviceContext) {
    const cfg = homematicGatewayDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homematicGatewayDeviceSchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.online = this.sessionUp()
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: cfg.nativeId, system: 'homematic' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.snapshotUnsub = homematicFacades.onSnapshot(this.integrationId, () => {
      void this.sync()
    })
    await this.sync()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  private sessionUp(): boolean {
    return homematicFacades.getSession(this.integrationId)?.getInfo().status === 'connected'
  }

  /** Follow the session: online state, and the box's host as device metadata. */
  private async sync(): Promise<void> {
    const up = this.sessionUp()
    if (this.online !== up) {
      this.markOnline(up)
      this.ctx.logger.info('Homematic gateway ' + (up ? 'online' : 'offline'), {
        tags: { deviceId: this.id },
      })
    }
    const session = homematicFacades.getSession(this.integrationId)
    if (session === null) return
    const patch = gatewayMetadataPatch({ host: session.getConnection().host })
    const key = JSON.stringify(patch)
    if (key === this.lastMetadataKey) return
    const action = this.ctx.api.deviceManager?.setMetadata
    if (action === undefined) return
    try {
      await action.mutate({ deviceId: this.id, patch })
      this.lastMetadataKey = key
    } catch (err) {
      this.ctx.logger.warn('Homematic gateway: metadata write failed', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** The CCU WebUI, on the CCU's own address and over TLS when the integration uses it. The password is NOT placed in the URL. */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `HomematicGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const connection = homematicFacades.getSession(this.integrationId)?.getConnection()
        if (connection === undefined) {
          this.ctx.logger.debug('homematic admin link unavailable: integration not running', {
            tags: { deviceId: this.id },
          })
          return null
        }
        const built = buildDeviceAdminUrl({
          host: connection.host,
          port: null,
          scheme: connection.tls ? 'https' : 'http',
          path: '/',
        })
        if (!built.ok) {
          this.ctx.logger.debug('homematic admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'CCU WebUI',
          target: 'integration' as const,
          host: connection.host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }
}
