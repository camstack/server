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
import { z } from 'zod'
import { ECOWITT_SYSTEM } from '../config.js'
import { ecowittConnections } from '../ecowitt-client-registry.js'
import { ecowittFacades } from '../ecowitt-gateway.js'
import { ecowittMacReader } from '../ecowitt-gateway-mac.js'
import { ecowittGatewayIdentifiers, needsGatewayMacRead } from '../ecowitt-identifiers.js'
import { registerEcowittStateRefresh } from '../ecowitt-state-refresh.js'

/** Marks the Gateway device's blob apart from a group Container's. */
export const ECOWITT_GATEWAY_DEVICE_KIND = 'gateway-device'

export const ecowittGatewayDeviceSchema = z.object({
  kind: z.literal(ECOWITT_GATEWAY_DEVICE_KIND),
  integrationId: z.string().min(1).describe('Owning integration'),
  /** The key the integration's live client is published under. */
  gatewayId: z.string().min(1).describe('Gateway key of the live client'),
  system: z.literal(ECOWITT_SYSTEM).optional(),
})

/**
 * The Ecowitt gateway itself, as a {@link DeviceType.Gateway} (it used to be a Hub with the
 * connection on it). The connection lives on the INTEGRATION; this device is the gateway's
 * presence in the device list and carries the one action the gateway really has,
 * `device-admin-link`, its own web page. The group Containers are NOT children of it; each is a
 * top-level sibling. Online follows the integration's live client.
 */
export class EcowittGatewayDevice extends BaseDevice<typeof ecowittGatewayDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string
  private readonly gatewayId: string
  /** The last declaration sent; an unchanged one is not re-sent. */
  private lastIdentityKey: string | null = null
  /** The "MAC unknown" reason is logged once, until a read succeeds. */
  private macUnknownLogged = false
  private stopStateRefresh: () => void = () => undefined
  /** `onActivate` ran: before it, an online flip from the constructor does no I/O. */
  private activated = false
  /** One MAC read per client start: a second flip while one runs does not start another. */
  private macReadInFlight = false

  constructor(ctx: DeviceContext) {
    const cfg = ecowittGatewayDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, ecowittGatewayDeviceSchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.gatewayId = cfg.gatewayId
    this.online = ecowittFacades.get(cfg.gatewayId) !== null
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: cfg.gatewayId, system: ECOWITT_SYSTEM })
  }

  override async removeDevice(): Promise<void> {
    this.stopStateRefresh()
    await super.removeDevice()
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.activated = true
    // The gateway is polled, never pushed to: the core schedules the reads (D1062).
    this.stopStateRefresh()
    this.stopStateRefresh = registerEcowittStateRefresh({
      ctx: this.ctx,
      logger: this.ctx.logger,
      deviceId: this.id,
      integrationId: this.integrationId,
      gatewayId: this.gatewayId,
      facades: ecowittFacades,
      connections: ecowittConnections,
    })
    // Fire-and-forget: the probe may wait 1.5 s, activation does not.
    if (this.online) this.startGatewayConnected()
  }

  /** The gateway's client came up: its connection is current, so read and declare from it. */
  override markOnline(online: boolean): void {
    const wasOnline = this.online
    super.markOnline(online)
    if (online && !wasOnline && this.activated) this.startGatewayConnected()
  }

  private startGatewayConnected(): void {
    this.onGatewayConnected().catch((err: unknown) => {
      this.ctx.logger.warn('ecowitt gateway identity on connect failed', {
        tags: { deviceId: this.id },
        meta: { integrationId: this.integrationId, error: errMsg(err) },
      })
    })
  }

  /**
   * Declare what the connection knows, then, when its MAC is unknown for the host it dials, read it
   * with ONE unicast probe, store it on the integration and declare again (D1059). A failed read
   * leaves the MAC unknown, logged once; it is tried again the next time the gateway's client
   * starts (addon boot or a connection edit) — no timer, no retry.
   */
  private async onGatewayConnected(): Promise<void> {
    await this.declareGatewayIdentity()
    const connection = ecowittConnections.get(this.integrationId)
    if (!needsGatewayMacRead(connection)) return
    const reader = ecowittMacReader.get()
    if (reader === null || this.macReadInFlight) return
    this.macReadInFlight = true
    try {
      const read = await reader.probe(connection.host)
      if (!read.ok) {
        this.logMacUnknown(connection.host, read.reason)
        return
      }
      await reader.persist(this.integrationId, read.mac, connection.host)
      this.macUnknownLogged = false
      this.ctx.logger.info('ecowitt gateway MAC read from the gateway', {
        tags: { deviceId: this.id },
        meta: { integrationId: this.integrationId, host: connection.host, mac: read.mac },
      })
      await this.declareGatewayIdentity()
    } catch (err) {
      this.logMacUnknown(connection.host, `store failed: ${errMsg(err)}`)
    } finally {
      this.macReadInFlight = false
    }
  }

  private logMacUnknown(host: string, reason: string): void {
    if (this.macUnknownLogged) return
    this.macUnknownLogged = true
    this.ctx.logger.warn('ecowitt gateway MAC unknown — not declared', {
      tags: { deviceId: this.id },
      meta: { integrationId: this.integrationId, host, reason },
    })
  }

  /** Declare the MAC read at the host the connection dials, and that host (D1059). */
  private async declareGatewayIdentity(): Promise<void> {
    const declaration = ecowittGatewayIdentifiers(ecowittConnections.get(this.integrationId))
    if (declaration === null) return
    const key = JSON.stringify(declaration)
    if (key === this.lastIdentityKey) return
    this.lastIdentityKey = key
    const result = await this.declareIdentifiers(declaration.identifiers, {
      unread: declaration.unread,
    })
    if (result.outcome !== 'declared') this.lastIdentityKey = null
  }

  /**
   * Only the `local` transport knows an address. In `listener` transport the gateway PUSHES to
   * this hub and the addon never learns where it lives, so the answer is null, logged.
   */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `EcowittGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const connection = ecowittConnections.get(this.integrationId)
        if (connection === null || connection.transport !== 'local') {
          this.ctx.logger.debug('ecowitt admin link unavailable: no local address', {
            tags: { deviceId: this.id },
            meta: { transport: connection?.transport ?? 'not-running' },
          })
          return null
        }
        const built = buildDeviceAdminUrl({
          host: connection.host,
          port: connection.port,
          scheme: 'http',
          path: '/',
        })
        if (!built.ok) {
          this.ctx.logger.debug('ecowitt admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'Gateway page',
          target: 'integration' as const,
          host: connection.host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }
}
