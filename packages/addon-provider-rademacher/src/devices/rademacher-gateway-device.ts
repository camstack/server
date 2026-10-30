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
import { rademacherGatewayDeviceSchema } from '../config.js'
import { gatewayMetadataPatch } from '../rademacher-gateway-metadata.js'
import { rademacherSessions } from '../rademacher-session-resolver.js'

/**
 * The physical HomePilot / Start2Smart box, as a {@link DeviceType.Gateway}. Its
 * connection and password live on the INTEGRATION; this device carries what
 * describes the box (model, firmware, MAC, host, whether the session is up) and
 * the one action the hub really supports through an existing cap:
 *
 * - `device-admin-link`, the hub's own web page.
 *
 * There is no `reboot` and no `update`: the hub API read by noderademacher
 * exposes neither a restart nor a way to start a firmware update (it only
 * reports that one is available), so none is advertised.
 *
 * Covers are NOT children of the gateway; they are adopted as their own
 * top-level devices of the same integration.
 */
export class RademacherGatewayDevice extends BaseDevice<typeof rademacherGatewayDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string
  private snapshotUnsub: (() => void) | null = null
  /** The last metadata written, so a poll that changed nothing writes nothing. */
  private lastMetadataKey = ''

  constructor(ctx: DeviceContext) {
    const cfg = rademacherGatewayDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, rademacherGatewayDeviceSchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.online = this.sessionUp()
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: cfg.nativeId, system: 'rademacher' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.snapshotUnsub = rademacherSessions.onSnapshot(this.integrationId, () => {
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
    return rademacherSessions.getManager(this.integrationId)?.status === 'connected'
  }

  /** Follow the session: online state, and the box's model, firmware, MAC and host as device metadata. */
  private async sync(): Promise<void> {
    const up = this.sessionUp()
    if (this.online !== up) {
      this.markOnline(up)
      this.ctx.logger.info('Rademacher gateway ' + (up ? 'online' : 'offline'), {
        tags: { deviceId: this.id },
      })
    }
    const manager = rademacherSessions.getManager(this.integrationId)
    if (manager === null) return
    const identity = manager.identity
    const patch = gatewayMetadataPatch({
      host: manager.getConnection().host,
      model: identity?.model ?? null,
      firmware: identity?.firmware ?? null,
      mac: identity?.uid ?? null,
    })
    const key = JSON.stringify(patch)
    if (key === this.lastMetadataKey) return
    const action = this.ctx.api.deviceManager?.setMetadata
    if (action === undefined) return
    try {
      await action.mutate({ deviceId: this.id, patch })
      this.lastMetadataKey = key
    } catch (err) {
      this.ctx.logger.warn('Rademacher gateway: metadata write failed', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * The HomePilot serves its web UI on plain HTTP at the hub's own address.
   * `basePath` is the operator's API base-path override ("" for v1, "/hp" for
   * v2) and is carried through, because a hub reached under a prefix serves its
   * page under the same prefix. The password is NOT placed in the URL.
   */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `RademacherGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const connection = rademacherSessions.getManager(this.integrationId)?.getConnection()
        if (connection === undefined) {
          this.ctx.logger.debug('rademacher admin link unavailable: integration not running', {
            tags: { deviceId: this.id },
          })
          return null
        }
        const built = buildDeviceAdminUrl({
          host: connection.host,
          port: null,
          scheme: 'http',
          path: connection.basePath === '' ? '/' : `${connection.basePath}/`,
        })
        if (!built.ok) {
          this.ctx.logger.debug('rademacher admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'HomePilot web UI',
          target: 'integration' as const,
          host: connection.host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }
}
