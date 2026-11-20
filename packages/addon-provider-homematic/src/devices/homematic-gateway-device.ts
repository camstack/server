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
import { watchdogFaultReading, watchdogFaultTypes } from '../homematic-fault-mapping.js'
import { gatewayMetadataPatch } from '../homematic-gateway-metadata.js'
import { registerHomematicStateRefresh } from '../homematic-state-refresh.js'

/**
 * The physical CCU3 / RaspberryMatic box, as a {@link DeviceType.Gateway}. Its
 * connection and password live on the INTEGRATION; this device follows whether
 * the session is up, carries the box's host as metadata and offers the one
 * action the library really supports through an existing cap:
 *
 * - `device-admin-link`, the CCU's own WebUI.
 *
 * - `error`, the faults the CCU WatchDog add-on raises as system variables
 *   (`homematic-fault-mapping.ts`), read by the core's `device-state-refresh` (D1062),
 *   because the CCU pushes no event for them.
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
  private polling = false
  private warnedReadFailure = false

  constructor(ctx: DeviceContext) {
    const cfg = homematicGatewayDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homematicGatewayDeviceSchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.online = this.sessionUp()
    this.registerAdminLinkCap()
    this.declareFaultTypes(watchdogFaultTypes())
    this.registerErrorCap()
    registerHomematicStateRefresh({
      ctx,
      integrationId: cfg.integrationId,
      readFaults: () => this.refreshFaults(),
    })
    void this.updateSourceInfo({ id: cfg.nativeId, system: 'homematic' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.snapshotUnsub = homematicFacades.onSnapshot(this.integrationId, () => {
      void this.sync()
      if (this.sessionUp()) void this.pollFaults()
    })
    await this.sync()
    await this.pollFaults()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  private sessionUp(): boolean {
    return homematicFacades.getSession(this.integrationId)?.getInfo().status === 'connected'
  }

  /**
   * The core's read (D1062): the CCU's WatchDog system variables, published as
   * faults. It THROWS when the session is down or the CCU does not answer, so
   * the core backs the cadence off; the previous reading stands meanwhile.
   */
  private async refreshFaults(): Promise<void> {
    const facade = homematicFacades.get(this.integrationId)
    if (!this.sessionUp() || facade === null) {
      throw new Error(`Homematic CCU not connected (integration ${this.integrationId})`)
    }
    await this.readFaultsFrom(facade)
  }

  private async readFaultsFrom(
    facade: NonNullable<ReturnType<typeof homematicFacades.get>>,
  ): Promise<void> {
    await facade.refreshHub()
    const reading = watchdogFaultReading(facade.systemVariables(), Date.now())
    if (reading.active === null) {
      this.ctx.logger.debug(
        'Homematic gateway: no WatchDog system variable readable on the CCU, faults stay unknown',
        { tags: { deviceId: this.id } },
      )
    }
    this.warnedReadFailure = false
    await this.publishError(reading)
  }

  /**
   * Read the faults when the CCU announced a new snapshot (it just reconnected
   * or changed). A read that fails changes nothing (the previous reading
   * stands), and every branch that publishes nothing leaves a line on the device.
   */
  async pollFaults(): Promise<void> {
    if (this.polling) return
    const tags = { deviceId: this.id }
    const facade = homematicFacades.get(this.integrationId)
    if (!this.sessionUp() || facade === null) {
      this.ctx.logger.debug('Homematic gateway: fault read skipped, session not connected', {
        tags,
      })
      return
    }
    this.polling = true
    try {
      await this.readFaultsFrom(facade)
    } catch (err) {
      const log = this.warnedReadFailure ? this.ctx.logger.debug : this.ctx.logger.warn
      this.warnedReadFailure = true
      log.call(
        this.ctx.logger,
        'Homematic gateway: fault read failed, the previous reading stands',
        {
          tags,
          meta: { error: errMsg(err) },
        },
      )
    } finally {
      this.polling = false
    }
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
    await this.declareIdentifiers({ host: session.getConnection().host })
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
