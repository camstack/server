import {
  BaseDevice,
  buildDeviceAdminUrl,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  deviceAdminLinkCapability,
  errMsg,
  type InferNativeProvider,
  rebootCapability,
} from '@camstack/types'
import { veluxGatewayDeviceSchema } from '../config.js'
import { gatewayMetadataPatch } from '../velux-gateway-metadata.js'
import { veluxGateways } from '../velux-node-resolver.js'

/**
 * The physical KLF-200 box, as a {@link DeviceType.Gateway}. Its connection and
 * password live on the INTEGRATION; this device carries what describes the box:
 * firmware, host and whether the session is up, plus the actions the gateway
 * really supports through existing caps:
 *
 * - `reboot` (GW_REBOOT_REQ), advertised as {@link DeviceFeature.Rebootable};
 * - `device-admin-link`, the unit's own web page.
 *
 * There is no `update`: the KLF-200 API offers no firmware update.
 *
 * Products are NOT children of the gateway; they are adopted as their own
 * top-level devices of the same integration.
 */
export class VeluxGatewayDevice extends BaseDevice<typeof veluxGatewayDeviceSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Rebootable]

  private readonly integrationId: string
  private snapshotUnsub: (() => void) | null = null
  /** The last metadata written, so a push that changed nothing writes nothing. */
  private lastMetadataKey = ''

  constructor(ctx: DeviceContext) {
    const cfg = veluxGatewayDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, veluxGatewayDeviceSchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.online = this.sessionUp()
    this.registerRebootCap()
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: cfg.nativeId, system: 'velux' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.snapshotUnsub = veluxGateways.onSnapshot(this.integrationId, () => {
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
    return veluxGateways.getManager(this.integrationId)?.status === 'connected'
  }

  /** Follow the session: online state, and the box's firmware and host as device metadata. */
  private async sync(): Promise<void> {
    const up = this.sessionUp()
    if (this.online !== up) {
      this.markOnline(up)
      this.ctx.logger.info('Velux gateway ' + (up ? 'online' : 'offline'), {
        tags: { deviceId: this.id },
      })
    }
    const manager = veluxGateways.getManager(this.integrationId)
    if (manager === null) return
    const patch = gatewayMetadataPatch({
      host: manager.getConnection().host,
      firmware: manager.firmware,
    })
    const key = JSON.stringify(patch)
    if (key === this.lastMetadataKey) return
    const action = this.ctx.api.deviceManager?.setMetadata
    if (action === undefined) return
    try {
      await action.mutate({ deviceId: this.id, patch })
      this.lastMetadataKey = key
    } catch (err) {
      this.ctx.logger.warn('Velux gateway: metadata write failed', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  private registerRebootCap(): void {
    const provider: InferNativeProvider<typeof rebootCapability> = {
      reboot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `VeluxGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const client = veluxGateways.getManager(this.integrationId)?.client ?? null
        if (client === null) {
          this.ctx.logger.warn('Velux gateway reboot refused: no live session', {
            tags: { deviceId: this.id },
          })
          throw new Error('The gateway session is down, so it cannot be told to reboot.')
        }
        await client.reboot()
        this.ctx.logger.info('Velux gateway reboot requested', { tags: { deviceId: this.id } })
        return { success: true as const }
      },
    }
    this.ctx.registerNativeCap(rebootCapability, provider)
  }

  /**
   * The KLF-200 serves its web interface over HTTPS only, with a self-signed
   * certificate — the browser warns, which is the unit's own behaviour. The
   * password is NOT placed in the URL; the page asks for it.
   */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `VeluxGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const host = veluxGateways.getManager(this.integrationId)?.getConnection().host
        if (host === undefined) {
          this.ctx.logger.debug('velux admin link unavailable: integration not running', {
            tags: { deviceId: this.id },
          })
          return null
        }
        const built = buildDeviceAdminUrl({ host, port: null, scheme: 'https', path: '/' })
        if (!built.ok) {
          this.ctx.logger.debug('velux admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'KLF-200 web interface',
          target: 'integration' as const,
          host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }
}
