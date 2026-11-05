import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  errMsg,
  type AccessoryChildSpec,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  hydrateSchema,
  type DeviceContext,
  type IDevice,
} from '@camstack/types'
import { DEFAULT_AC_CAPABILITIES, type AcCapabilities } from '@apocaliss92/nodegree'
import { greeAcDeviceSchema, type GreeConfig, mergeConnectionPatch } from '../config.js'
import { greeConnections } from '../gree-gateway.js'
import { GreeIntegrationManager, type GreeMoved } from '../gree-integration-manager.js'
import { greeScanScope, sweepGreeSubnets } from '../gree-sweep.js'
import { GreeAcDevice } from './gree-ac-device.js'
import { GreeToggleDevice, type GreeToggleKind } from './gree-toggle-device.js'

/**
 * Standalone-mode parent Container device for a single Gree AC (Reolink /
 * Ecowitt pattern). The operator-supplied CONNECTION lives on THIS device's
 * config; the device OWNS exactly one live `@apocaliss92/nodegree` client (via a
 * {@link GreeIntegrationManager}) keyed on its own `connectionKey` and published
 * on the in-process {@link greeConnections} resolver so its AC + toggle accessory
 * children read the live bound handle. There is NO broker and NO device-adoption
 * cap.
 *
 * It owns no control caps itself — it declares `getAccessoryChildren()` so the
 * kernel auto-spawns the single {@link GreeAcDevice} accessory child (Thermostat,
 * carrying `climate-control` + `fan-control` with the swing entities) plus
 * presence-gated {@link DeviceType.Switch} children for the panel-light / X-Fan /
 * health / fresh-air boolean flags (mirroring the HA Gree integration).
 * Capability presence is resolved from the bound handle's `AcCapabilities` (or
 * model defaults when no live handle).
 */
export class GreeContainerDevice extends BaseDevice<typeof greeAcDeviceSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly greeMac: string
  private readonly connectionKey: string
  private readonly integrationId: string | undefined
  private connection: GreeConfig
  private manager: GreeIntegrationManager | null = null

  constructor(ctx: DeviceContext) {
    const cfg = greeAcDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, greeAcDeviceSchema, { type: DeviceType.Container })
    this.greeMac = cfg.greeMac
    this.connectionKey = cfg.connectionKey
    this.integrationId = cfg.integrationId
    this.connection = cfg.connection
    // online derives from whether the bound handle is currently present.
    this.online = greeConnections.getDevice(this.connectionKey, this.greeMac) !== null
    void this.updateSourceInfo({ id: this.greeMac, system: 'gree' })
  }

  /** Adopt a pre-built manager (created by `onCreateDevice` so the live client
   *  binds once at create time) — mirrors `EcowittGatewayDevice.adoptManager`. */
  adoptManager(manager: GreeIntegrationManager): void {
    this.manager = manager
    manager.attachOwner((move) => void this.persistMove(move))
  }

  /** The fallback sweep found the AC at a new address: keep it (the manager already dials it). */
  private async persistMove(move: GreeMoved): Promise<void> {
    this.connection = move.connection
    await this.config
      .setAll({ connection: move.connection, greeIp: move.newIp })
      .catch((err: unknown) => {
        this.ctx.logger.warn('Gree AC: could not persist the new address', {
          tags: { deviceId: this.id },
          meta: { newIp: move.newIp, error: errMsg(err) },
        })
      })
  }

  /** The connection as the discovery follow step and the settings form read it. */
  getHost(): string {
    return this.connection.host
  }

  getConnection(): GreeConfig {
    return this.connection
  }

  getGreeMac(): string {
    return this.greeMac
  }

  /** Operator-editable address of the AC (the rest of the UDP tuning stays in the creation form). */
  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'connection',
          title: 'Connection',
          titleKey: 'provider-gree:container.s_connection.title',
          columns: 1,
          fields: [
            {
              type: 'text',
              key: 'host',
              label: 'IP address',
              labelKey: 'provider-gree:connection.s_identity.host.label',
              description:
                'Where the air conditioner answers. Changing it reconnects; the device and its history stay.',
              descriptionKey: 'provider-gree:container.host.description',
              placeholder: '192.168.10.50',
            },
            {
              type: 'text',
              key: 'broadcastAddr',
              label: 'Broadcast address (optional)',
              labelKey: 'provider-gree:connection.s_advanced.broadcastAddr.label',
              placeholder: '192.168.10.255',
            },
          ],
        },
      ],
    }
    return hydrateSchema(schema, {
      host: this.connection.host,
      broadcastAddr: this.connection.broadcastAddr,
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // Best-effort first dial. A manager may already be adopted from create; on
    // restore we build + start one here. Failures are logged; the AC handle is
    // simply absent until the next successful bind.
    if (this.manager === null) {
      void this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Gree AC initial bind failed', {
          tags: { deviceId: this.id },
          meta: { greeMac: this.greeMac, error: errMsg(err) },
        })
      })
    }
  }

  override async removeDevice(): Promise<void> {
    const mgr = this.manager
    this.manager = null
    if (mgr) {
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('Gree AC: client stop failed', {
          tags: { deviceId: this.id },
          meta: { greeMac: this.greeMac, error: errMsg(err) },
        })
      }
    }
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    // The connection is operator-editable: the whole `connection` blob (the
    // discovery follow step) or the `host` / `broadcastAddr` fields of the
    // settings form. A change rebuilds the bound client; ids and children stay.
    // Re-parse through the schema so defaults apply.
    const parsed = mergeConnectionPatch(this.connection, patch)
    if (parsed === null) return
    await this.config.setAll({
      connection: parsed,
      ...(parsed.host.length > 0 ? { greeIp: parsed.host } : {}),
    })
    this.connection = parsed
    const mgr = this.manager
    if (mgr) {
      try {
        await mgr.applyConnection(parsed)
      } catch (err) {
        this.ctx.logger.warn('Gree AC: applyConnection failed', {
          tags: { deviceId: this.id },
          meta: { greeMac: this.greeMac, error: errMsg(err) },
        })
      }
    } else {
      await this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Gree AC re-bind after settings change failed', {
          tags: { deviceId: this.id },
          meta: { greeMac: this.greeMac, error: errMsg(err) },
        })
      })
    }
  }

  /** Build + start the per-device nodegree client (if not already running). */
  private async ensureManager(): Promise<void> {
    if (this.manager !== null) return
    const mgr = new GreeIntegrationManager({
      id: this.connectionKey,
      deviceId: this.id,
      name: this.name,
      connection: this.connection,
      logger: this.ctx.logger,
      onConnected: () => this.setAcOnline(true),
      onDisconnected: () => this.setAcOnline(false),
      surfaceSink: greeConnections,
      expectMac: this.greeMac,
      fallbackSweep: () =>
        sweepGreeSubnets({
          subnets: greeScanScope.get(),
          logger: this.ctx.logger,
        }),
      onMoved: (move) => void this.persistMove(move),
    })
    this.manager = mgr
    await mgr.start()
  }

  private setAcOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    void this.setChildrenOnline(online).catch(() => {
      /* best-effort */
    })
  }

  private async setChildrenOnline(online: boolean): Promise<void> {
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.online === online) continue
      child.markOnline(online)
    }
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const meta: AccessoryChildSpec['meta'] = {
      type: DeviceType.Climate,
      name: this.name,
      linkDeviceId: this.id,
      ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
    }
    const config: Record<string, unknown> = {
      greeMac: this.greeMac,
      connectionKey: this.connectionKey,
      system: 'gree',
      ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
    }
    const acChild: AccessoryChildSpec = {
      stableIdSuffix: 'ac',
      meta,
      config,
      factory: (childCtx: DeviceContext): IDevice => new GreeAcDevice(childCtx),
    }
    return [acChild, ...this.toggleChildren()]
  }

  /**
   * Presence-gated boolean-flag switch children. `light` is universal (every
   * Gree AC has a panel light — no capability flag gates it); X-Fan / health /
   * fresh-air are gated on the resolved `AcCapabilities` (falling back to model
   * defaults when no live handle is bound yet).
   */
  private toggleChildren(): readonly AccessoryChildSpec[] {
    const caps: AcCapabilities =
      greeConnections.getDevice(this.connectionKey, this.greeMac)?.capabilities ??
      DEFAULT_AC_CAPABILITIES

    const wanted: readonly GreeToggleDescriptor[] = [
      { toggle: 'light', suffix: 'light', label: 'Light', present: true },
      { toggle: 'xfan', suffix: 'xfan', label: 'X-Fan', present: caps.xfan },
      {
        toggle: 'health',
        suffix: 'health',
        label: 'Health',
        present: caps.health,
      },
      {
        toggle: 'freshAir',
        suffix: 'freshair',
        label: 'Fresh Air',
        present: caps.freshAir,
      },
    ]

    return wanted
      .filter((d) => d.present)
      .map((d): AccessoryChildSpec => {
        const childMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Switch,
          name: `${this.name} ${d.label}`,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        const childConfig: Record<string, unknown> = {
          toggle: d.toggle,
          greeMac: this.greeMac,
          connectionKey: this.connectionKey,
          system: 'gree',
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        return {
          stableIdSuffix: d.suffix,
          meta: childMeta,
          config: childConfig,
          factory: (childCtx: DeviceContext): IDevice => new GreeToggleDevice(childCtx),
        }
      })
  }
}

/** One presence-gated toggle child descriptor (resolved per `AcCapabilities`). */
interface GreeToggleDescriptor {
  readonly toggle: GreeToggleKind
  readonly suffix: string
  readonly label: string
  readonly present: boolean
}
