/**
 * Google Home Export addon — hub-side.
 *
 * Architecture:
 *
 *   Google Home / Assistant --HTTPS--> POST /addon/export-google/fulfillment/<instanceId>
 *                                      (hub Fastify → addon-routes cap)
 *
 * The addon is MULTI-instance (planning#422): every Actions-console project is one
 * `integration-instances` row of the `google-homes` kind with its own exposure and its own
 * link ledger. The first instance keeps the id `export-google`, so the legacy
 * `/fulfillment` URL still answers for it. One OAuth client serves every instance.
 *
 * There is no cloud function in the middle. Google's smart-home platform calls
 * the fulfillment URL the operator configured, so the hub answers directly —
 * a shorter path than Alexa's, which needs an operator-owned Lambda because
 * Amazon will only talk to a Lambda ARN.
 *
 * Capabilities registered:
 *   - `device-export`      — the operator picks which devices Google sees.
 *   - `addon-routes`       — mounts `/addon/export-google/fulfillment[/<instanceId>]`.
 *   - `integration-instances` — the Google Home instances (role `services`).
 *   - `oauth-integration`  — declares this addon a linkable client of the
 *                            hub's core `/api/oauth2/*` server.
 *
 * ## What this addon does NOT hold
 *
 * Any Google credential. Account linking runs on the hub's own OAuth server,
 * and the one part of the Google contract that requires a Google-issued secret
 * — proactive Report State against the HomeGraph API, authenticated with a
 * service-account key — is deliberately not implemented. Every device is
 * therefore synced with `willReportState: false` and Google polls QUERY.
 * The full reasoning, and the rule that a HomeGraph key must never become an
 * addon setting, is in docs/decisions/adr-0269-a-google-export-that-holds-no-google-credential.md.
 *
 * ## Scope
 *
 * Switches, dimmable lights, locks and covers — the non-camera fleet neither
 * `export-hap` nor `export-alexa` covers. Cameras are out of scope on purpose
 * (docs/decisions/adr-0273-one-capability-is-one-trait-row-that-declares-reads-and-writes.md); the trait catalog is the single place that
 * decides, so widening scope is one row.
 */
import { randomUUID } from 'node:crypto'
import {
  addonRoutesCapability,
  BaseAddon,
  buildAddonRouteProvider,
  type ConfigSectionWithValues,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  defineAddonMigrations,
  deviceExportCapability,
  deviceExportStatusInstanceOf,
  errMsg,
  ExportInstanceUnknownError,
  exposedNameStoreOf,
  freeTextNameValidator,
  readExposedName,
  saveExposedName,
  type IAddonRouteProvider,
  type IDeviceExportProvider,
  type IOauthIntegrationProvider,
  integrationInstancesCapability,
  oauthIntegrationCapability,
  type ProviderRegistration,
  RecordIntegrationInstances,
  RevConflictError,
  isInstanceEnabled,
} from '@camstack/types'

import { ActionSceneExports } from './action-scenes.js'
import { createApiDeviceGateway, type DeviceGateway } from './device-gateway.js'
import {
  GOOGLE_INSTANCE_ID,
  type GoogleHomeBody,
  googleExportsKind,
  googleHomesKind,
  googleLinksKind,
} from './export-records.js'
import type { FulfillmentDeps } from './fulfillment-router.js'
import {
  GoogleInstance,
  GoogleInstanceRegistry,
  type GoogleInstanceStores,
} from './google-instance.js'
import { SUPPORTED_DEVICE_KINDS } from './google-home/device-model.js'
import { traitsForCaps } from './google-home/trait-catalog.js'
import { buildRoutes, type FulfillmentLookup } from './http-server.js'
import { ADDON_MIGRATIONS } from './migrations/index.js'
import { buildGoogleOauthIntegration } from './oauth-integration.js'
import { buildConsoleSetupFromRole } from './public-endpoint.js'
import { DEFAULT_SETTINGS, type ExportSetup, type GoogleExportSettings } from './types.js'

const ADDON_ID = 'export-google'
/**
 * Google Home's naming rule for a device name (D1049). Google publishes no character set for
 * `name.name`; it refuses control characters and very long names, so free text up to 60.
 */
const GOOGLE_NAME_MAX_LENGTH = 60
const GOOGLE_NAME_VALIDATOR = freeTextNameValidator('Google Home', GOOGLE_NAME_MAX_LENGTH)

/** The per-device toggle key: `google:<instanceId>:<deviceId>:enabled`. */
const DEVICE_KEY = /^google:([^:]+):(\d+):enabled$/
const deviceKey = (instanceId: string, deviceId: number): string =>
  `google:${instanceId}:${deviceId}:enabled`

export class ExportGoogleAddon extends BaseAddon<GoogleExportSettings> {
  private gateway: DeviceGateway | null = null
  private registry: GoogleInstanceRegistry | null = null
  private instances: RecordIntegrationInstances<GoogleHomeBody> | null = null
  private readonly fulfillments = new WeakMap<GoogleInstance, FulfillmentDeps>()

  constructor() {
    super({ ...DEFAULT_SETTINGS })
  }

  private requireRegistry(): GoogleInstanceRegistry {
    if (this.registry === null) throw new Error('export-google: addon not initialized')
    return this.registry
  }

  /** The instance or a typed refusal naming it: a device-export call never guesses one. */
  private async requireInstance(instanceId: string): Promise<GoogleInstance> {
    const instance = await this.requireRegistry().get(instanceId)
    if (instance === null) throw new ExportInstanceUnknownError(ADDON_ID, instanceId)
    return instance
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const gateway = createApiDeviceGateway({
      api: this.ctx.api,
      logger: this.ctx.logger,
    })
    this.gateway = gateway

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('export-google needs ctx.records — check execution.placement (hub-only)')
    }
    await records.declare({
      'google-homes': googleHomesKind,
      'google-exports': googleExportsKind,
      'google-links': googleLinksKind,
    })
    const stores: GoogleInstanceStores = {
      homes: records.kind(googleHomesKind),
      exports: records.kind(googleExportsKind),
      links: records.kind(googleLinksKind),
    }
    const registry = new GoogleInstanceRegistry(
      stores,
      this.ctx.logger,
      (persist, initial) =>
        new ActionSceneExports(
          {
            api: this.ctx.api,
            logger: this.ctx.logger,
            isAdminUser: async (userId) => {
              const users = await this.ctx.api.userManagement.listUsers.query()
              return users.some((u) => u.id === userId && u.isAdmin)
            },
            persist,
          },
          initial,
        ),
    )
    this.registry = registry

    this.instances = new RecordIntegrationInstances(records, googleHomesKind, {
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'homes',
        canTest: false,
        kinds: [
          { id: 'homes', label: 'Google Home', functionCap: 'device-export', role: 'services' },
        ],
      },
      formSchema: (id) => this.homeForm(id),
      initialBody: (name): GoogleHomeBody => ({ name }),
      mintId: () => `google-home-${randomUUID().slice(0, 8)}`,
      health: (body, id) => {
        if (!isInstanceEnabled(body)) return { status: { state: 'off', label: 'Off' } }
        const linked = registry.peek(id)?.linkedAccounts.length
        if (linked === undefined) return { status: { state: 'unknown' } }
        return linked > 0
          ? { status: { state: 'ok', label: `${linked} linked account(s)` } }
          : { status: { state: 'unknown', label: 'Not linked yet' } }
      },
      configured: () => true,
      onChanged: (id, change) => this.onInstanceChanged(id, change),
    })

    await this.runMigrations(
      defineAddonMigrations(ADDON_MIGRATIONS, {
        readStored: async () => this.resolveGlobalStore(),
        warn: (message) => {
          this.ctx.logger.warn(message, { tags: { topic: 'export-google', phase: 'migration' } })
        },
        putExports: async (body) => {
          if ((await stores.exports.get(GOOGLE_INSTANCE_ID)) !== null) return 'exists'
          try {
            await stores.exports.put({ id: GOOGLE_INSTANCE_ID, data: body }, { ifRev: 0 })
          } catch (err: unknown) {
            if (err instanceof RevConflictError) return 'exists'
            throw err
          }
          return 'created'
        },
        readExports: async () => (await stores.exports.get(GOOGLE_INSTANCE_ID))?.data ?? null,
        putHome: async (body) => {
          if ((await stores.homes.get(GOOGLE_INSTANCE_ID)) !== null) return 'exists'
          try {
            await stores.homes.put({ id: GOOGLE_INSTANCE_ID, data: body }, { ifRev: 0 })
          } catch (err: unknown) {
            if (err instanceof RevConflictError) return 'exists'
            throw err
          }
          return 'created'
        },
        putLinks: async (body) => {
          if ((await stores.links.get(GOOGLE_INSTANCE_ID)) !== null) return 'exists'
          try {
            await stores.links.put({ id: GOOGLE_INSTANCE_ID, data: body }, { ifRev: 0 })
          } catch (err: unknown) {
            if (err instanceof RevConflictError) return 'exists'
            throw err
          }
          return 'created'
        },
        readHome: async () => (await stores.homes.get(GOOGLE_INSTANCE_ID))?.data ?? null,
        readLinks: async () => (await stores.links.get(GOOGLE_INSTANCE_ID))?.data ?? null,
      }),
    )

    // A failed read of an instance's exposure or links stops the boot: an empty membership would
    // tell Google on its next SYNC that every device is gone, and an empty ledger written back
    // would forget every link.
    for (const row of await registry.list()) {
      const instance = await registry.get(row.id)
      if (instance === null) continue
      // The operator may have deleted an action while this addon was down.
      void instance.scenes.reconcile().catch((err: unknown) => {
        this.ctx.logger.warn('export-google: action scene reconcile at boot failed', {
          meta: { instanceId: instance.id, error: errMsg(err) },
        })
      })
    }

    const deviceExportProvider = this.buildDeviceExportProvider()

    const routes = buildRoutes({
      ctx: this.ctx,
      logger: this.ctx.logger,
      resolveFulfillment: (instanceId) => this.resolveFulfillment(instanceId),
    })
    const routeProvider: IAddonRouteProvider = buildAddonRouteProvider(ADDON_ID, routes)

    // Read on the authorize path, so the descriptor is static and this addon
    // must not register it behind an await — a provider goes live only once
    // `onInitialize` RETURNS.
    const oauthIntegrationProvider: IOauthIntegrationProvider = {
      getDescriptor: async () => buildGoogleOauthIntegration(),
    }

    this.ctx.logger.info('export-google: initialized', {
      meta: {
        instances: (await registry.list()).length,
        // Stated in the boot log because it is the single most surprising
        // property of this addon: state reaches Google by polling only.
        willReportState: false,
      },
    })

    return [
      { capability: deviceExportCapability, provider: deviceExportProvider },
      { capability: addonRoutesCapability, provider: routeProvider },
      { capability: oauthIntegrationCapability, provider: oauthIntegrationProvider },
      { capability: integrationInstancesCapability, provider: this.instances.toProvider() },
    ]
  }

  protected override async onShutdown(): Promise<void> {
    this.gateway = null
    this.registry = null
  }

  // ── Instances ───────────────────────────────────────────────────

  private async onInstanceChanged(
    id: string,
    change: 'created' | 'updated' | 'enabled' | 'deleted',
  ): Promise<void> {
    const registry = this.requireRegistry()
    if (change === 'deleted') await registry.remove(id)
    else if (change === 'created') await registry.get(id)
    else await registry.refreshHome(id)
  }

  private homeForm(id: string | null): ConfigUISchema {
    const target = id === null ? '<instance id>' : id
    return this.schema({
      sections: [
        {
          id: ADDON_ID,
          title: 'Connection',
          description:
            'Publishes switches, dimmable lights, locks and covers to Google Home. The hub answers Google directly — no cloud function, and no Google credential is stored here.',
          columns: 1,
          fields: [
            {
              type: 'info' as const,
              key: '__google-setup-banner',
              label: 'Setup overview',
              variant: 'info' as const,
              content: [
                'This hub must be reachable from the public internet over HTTPS (Cloudflare Tunnel, Tailscale Funnel, …) — Google calls the fulfillment URL from its own cloud.',
                `Create a cloud-to-cloud integration in the Google Home Developer Console, paste the three URLs from the Export panel (the fulfillment URL ends in /fulfillment/${target}), and link your account from the Home app.`,
                'Each Google Home instance is one Actions-console project with its own devices and linked accounts.',
                'Cameras are not exported, and state is not pushed: Google polls. Ask "Hey Google, sync my devices" after exposing something new.',
              ].join('\n'),
            },
          ],
        },
      ],
    })
  }

  private async resolveFulfillment(instanceId: string): Promise<FulfillmentLookup> {
    const instance = await this.requireRegistry().get(instanceId)
    if (instance === null) return { ok: false, code: 'unknown_instance' }
    if (!instance.enabled) return { ok: false, code: 'instance_disabled' }
    return { ok: true, deps: this.fulfillmentFor(instance) }
  }

  /** The fulfillment wiring of ONE instance: its exposure, its links, nobody else's. */
  private fulfillmentFor(instance: GoogleInstance): FulfillmentDeps {
    const cached = this.fulfillments.get(instance)
    if (cached !== undefined) return cached
    const gateway = this.requireGateway()
    const logger = this.ctx.logger
    const deps: FulfillmentDeps = {
      logger,
      sync: {
        gateway,
        logger,
        // An in-process read of this instance's OWN record — no cap-router round-trip for a
        // value we already hold.
        listExposed: () => instance.devices.map((entry) => entry.deviceId),
        exposedName: (deviceId) => this.exposedNameOf(instance.id, deviceId),
        actions: instance.scenes,
      },
      query: {
        gateway,
        logger,
        isExposed: (deviceId) => instance.isExposed(deviceId),
        actions: instance.scenes,
      },
      execute: {
        gateway,
        logger,
        isExposed: (deviceId) => instance.isExposed(deviceId),
        actions: instance.scenes,
      },
      recordLink: (caller) => instance.recordLink(caller),
      removeLink: (userId) => instance.removeLink(userId),
    }
    this.fulfillments.set(instance, deps)
    return deps
  }

  // ── device-export ───────────────────────────────────────────────

  private buildDeviceExportProvider(): IDeviceExportProvider {
    return {
      getStatus: async (input) => {
        const requested = deviceExportStatusInstanceOf(input)
        const rows = await this.requireRegistry().list()
        const target = requested ?? rows[0]?.id
        if (target === undefined) {
          return {
            linkState: 'unlinked',
            exposedDeviceCount: 0,
            setup: await this.buildSetupBlock(undefined, 0),
          }
        }
        const instance = await this.requireInstance(target)
        return {
          linkState: instance.linkedAccounts.length > 0 ? 'linked' : 'unlinked',
          exposedDeviceCount: instance.devices.length,
          setup: await this.buildSetupBlock(instance.id, instance.linkedAccounts.length),
        }
      },
      listInstances: async () =>
        (await this.requireRegistry().list()).map((row) => ({
          instanceId: row.id,
          name: row.body.name,
          enabled: isInstanceEnabled(row.body),
          kind: 'google-home',
        })),
      listSupportedDeviceKinds: async ({ instanceId }) => {
        await this.requireInstance(instanceId ?? GOOGLE_INSTANCE_ID)
        return [...SUPPORTED_DEVICE_KINDS]
      },
      listExposedDevices: async ({ instanceId }) => {
        const instance = await this.requireInstance(instanceId ?? GOOGLE_INSTANCE_ID)
        const out = []
        for (const entry of instance.devices) {
          const exposedName = await this.exposedNameOf(instance.id, entry.deviceId)
          out.push({
            deviceId: String(entry.deviceId),
            ...(exposedName !== null ? { exposedName } : {}),
          })
        }
        return out
      },
      exposeDevice: async ({ instanceId, deviceId, exposedName }) => {
        const instance = await this.requireInstance(instanceId ?? GOOGLE_INSTANCE_ID)
        if (exposedName !== undefined) await this.setExposedName(instance, deviceId, exposedName)
        return this.exposeDevice(instance, deviceId)
      },
      setExposedName: async ({ instanceId, deviceId, name }) =>
        this.setExposedName(await this.requireInstance(instanceId), deviceId, name),
      unexposeDevice: async ({ instanceId, deviceId }) =>
        this.unexposeDevice(await this.requireInstance(instanceId ?? GOOGLE_INSTANCE_ID), deviceId),
      listSupportedEntityKinds: async () => ['device', 'action'],
      listExposedEntities: async ({ instanceId }) => {
        const instance = await this.requireInstance(instanceId ?? GOOGLE_INSTANCE_ID)
        await instance.scenes.reconcile()
        return [
          ...instance.devices.map((entry) => ({
            entity: { kind: 'device' as const, deviceId: String(entry.deviceId) },
          })),
          ...instance.scenes.list(),
        ]
      },
      exposeEntity: async ({ instanceId, entity }) => {
        const instance = await this.requireInstance(instanceId ?? GOOGLE_INSTANCE_ID)
        if (entity.kind === 'device') return this.exposeDevice(instance, entity.deviceId)
        if (entity.kind === 'action') return instance.scenes.expose(entity.actionId)
        throw new Error('export-google: a notification target cannot be exported to Google Home')
      },
      unexposeEntity: async ({ instanceId, entity }) => {
        const instance = await this.requireInstance(instanceId ?? GOOGLE_INSTANCE_ID)
        if (entity.kind === 'device') return this.unexposeDevice(instance, entity.deviceId)
        if (entity.kind === 'action') return instance.scenes.unexpose(entity.actionId)
        throw new Error('export-google: a notification target cannot be exported to Google Home')
      },
      // `device-export` types deviceId as a string; our entries key on numbers.
      getDeviceSettingsContribution: (input) =>
        this.buildDeviceSettingsContribution(Number(input.deviceId)),
      getDeviceLiveContribution: async () => null,
      applyDeviceSettingsPatch: (input) =>
        this.applyDeviceSettingsPatch(Number(input.deviceId), input.patch),
    }
  }

  private async exposedNameOf(instanceId: string, deviceId: number): Promise<string | null> {
    try {
      const store = exposedNameStoreOf(this.ctx.settings, ADDON_ID)
      return readExposedName(await store.read(deviceId), instanceId, GOOGLE_NAME_VALIDATOR)
    } catch (err) {
      // A failed read names nothing: the listing and SYNC answer the device name.
      this.ctx.logger.warn('export-google: Google name unreadable', {
        tags: { deviceId },
        meta: { instanceId, error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * The Google Home name of a device on this instance (D1049). Saved only: Google reads names
   * on its next SYNC (the hub cannot request one, see `exposeDevice`), under the same device id.
   */
  private async setExposedName(
    instance: GoogleInstance,
    deviceIdRaw: string,
    raw: string | null,
  ): Promise<void> {
    const deviceId = Number.parseInt(deviceIdRaw, 10)
    if (!Number.isFinite(deviceId)) {
      throw new Error(`export-google: deviceId must be numeric — got "${deviceIdRaw}"`)
    }
    const saved = await saveExposedName({
      store: exposedNameStoreOf(this.ctx.settings, ADDON_ID),
      deviceId,
      instanceId: instance.id,
      raw,
      validate: GOOGLE_NAME_VALIDATOR,
    })
    if (saved.changed) {
      this.ctx.logger.info(
        'export-google: Google name saved — Google shows it after its next SYNC',
        {
          tags: { deviceId },
          meta: { instanceId: instance.id, name: saved.name },
        },
      )
    }
  }

  private async exposeDevice(instance: GoogleInstance, deviceIdRaw: string): Promise<void> {
    const deviceId = Number.parseInt(deviceIdRaw, 10)
    if (!Number.isFinite(deviceId)) {
      throw new Error(`export-google: deviceId must be numeric — got "${deviceIdRaw}"`)
    }

    const facts = await this.requireGateway()
      .loadFacts(deviceId)
      .catch((err: unknown) => {
        throw new Error(`export-google: registry read failed: ${errMsg(err)}`)
      })
    if (facts === null) throw new Error(`export-google: device ${deviceId} not found`)

    // `listSupportedDeviceKinds` is only a UI filter — nothing enforces it on
    // `exposeDevice`. Refuse HERE, with the reason, rather than accepting a
    // device that would then be silently dropped from every SYNC.
    if (traitsForCaps(facts.capNames).length === 0) {
      this.ctx.logger.warn('export-google: refused to expose — no exported capability', {
        tags: { deviceId },
        meta: {
          instanceId: instance.id,
          deviceType: facts.deviceType,
          capNames: facts.capNames,
        },
      })
      throw new Error(
        `export-google: device ${deviceId} has no capability this addon exports (bound: ${facts.capNames.join(', ') || 'none'})`,
      )
    }

    const next = instance.devices.filter((e) => e.deviceId !== deviceId)
    await instance.writeExports({ devices: [...next, { deviceId, exposedAt: Date.now() }] })

    // Google learns about a new device only on its next SYNC, and the hub
    // cannot ASK for one: `requestSync` is a HomeGraph call and HomeGraph needs
    // the service-account key this addon deliberately does not hold. Say so on
    // the line an operator will read when the device fails to appear.
    this.ctx.logger.info(
      'export-google: exposed device — visible after the next Google SYNC ("Hey Google, sync my devices")',
      { tags: { deviceId }, meta: { instanceId: instance.id } },
    )
  }

  private async unexposeDevice(instance: GoogleInstance, deviceIdRaw: string): Promise<void> {
    const deviceId = Number.parseInt(deviceIdRaw, 10)
    if (!Number.isFinite(deviceId)) return
    const next = instance.devices.filter((e) => e.deviceId !== deviceId)
    if (next.length === instance.devices.length) return
    await instance.writeExports({ devices: next })
    this.ctx.logger.info('export-google: unexposed device — removed from Google on its next SYNC', {
      tags: { deviceId },
      meta: { instanceId: instance.id },
    })
  }

  private requireGateway(): DeviceGateway {
    if (this.gateway === null) throw new Error('export-google: addon not initialized')
    return this.gateway
  }

  // ── Settings surfaces ───────────────────────────────────────────

  /**
   * The three URLs the operator pastes into the Actions console, plus the
   * linked-account count.
   *
   * No row is marked `secret: true`, and that is not an oversight: this addon
   * holds nothing secret. `ExportSetupField.secret` masks in the UI only — the
   * value still travels in the `getStatus` response — so it would be the wrong
   * tool for a real credential anyway (docs/decisions/adr-0269-a-google-export-that-holds-no-google-credential.md).
   */
  private async buildSetupBlock(
    instanceId: string | undefined,
    linkedAccounts: number,
  ): Promise<ExportSetup> {
    return buildConsoleSetupFromRole({
      addonId: ADDON_ID,
      ...(instanceId !== undefined ? { instanceId } : {}),
      linkedAccounts,
      read: () => this.ctx.api.localNetwork.getAddresses.query(),
    })
  }

  /**
   * Per-device "Export" panel: one section per enabled instance. Offered only for devices this
   * addon can actually represent — a toggle on a camera would be a switch that promises
   * something `buildSyncDevice` then refuses.
   */
  private async buildDeviceSettingsContribution(
    deviceId: number,
  ): Promise<ConfigUISchemaWithValues | null> {
    const facts = await this.requireGateway()
      .loadFacts(deviceId)
      .catch(() => null)
    if (facts === null) return null
    const descriptors = traitsForCaps(facts.capNames)
    if (descriptors.length === 0) return null

    const registry = this.requireRegistry()
    const rows = (await registry.list()).filter((row) => isInstanceEnabled(row.body))
    const sections: ConfigSectionWithValues[] = []
    for (const row of rows) {
      const instance = await registry.get(row.id)
      if (instance === null) continue
      const enabled = instance.isExposed(deviceId)
      const linked = instance.linkedAccounts.length
      const statusLabel = enabled
        ? `Exposed as ${descriptors.map((d) => d.trait.replace('action.devices.traits.', '')).join(' + ')}${
            linked > 0 ? `, ${linked} linked Google account(s)` : ' (no linked Google account yet)'
          }`
        : 'Not exposed'
      sections.push({
        id: `${ADDON_ID}:${instance.id}`,
        title: rows.length === 1 ? 'Google Home Export' : `Google Home Export — ${instance.name}`,
        description: 'Surface this device to the linked Google Home account.',
        tab: 'export',
        columns: 1,
        order: 30 + sections.length,
        fields: [
          {
            type: 'info' as const,
            key: `__google-status:${instance.id}`,
            label: 'Status',
            content: statusLabel,
            variant: 'info' as const,
          },
          {
            type: 'boolean' as const,
            // Namespaced per exporter AND instance: the device-aggregate form flattens fields
            // by `key` across sections, so a bare `enabled` would collide with HAP's and Alexa's
            // and one instance's toggle would drive another's.
            key: deviceKey(instance.id, deviceId),
            label: 'Expose to Google Home',
            description:
              'Google picks the change up on its next sync — say "Hey Google, sync my devices" to force one.',
            style: 'switch' as const,
            value: enabled,
            // Auto-save: a single toggle has no draft state worth reviewing, and
            // the operator expects expose/unexpose to fire on release.
            immediate: true,
          },
        ],
      })
    }
    if (sections.length === 0) return null
    return { tabs: [{ id: 'export', label: 'Export', icon: 'share-2', order: 80 }], sections }
  }

  private async applyDeviceSettingsPatch(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<{ success: true }> {
    for (const [key, next] of Object.entries(patch)) {
      const match = DEVICE_KEY.exec(key)
      if (match === null || Number(match[2]) !== deviceId) continue
      const instanceId = match[1] ?? ''
      if (typeof next !== 'boolean') {
        this.ctx.logger.warn('export-google: ignored export toggle — value was not a boolean', {
          tags: { deviceId },
          meta: { instanceId },
        })
        continue
      }
      const instance = await this.requireInstance(instanceId)
      if (next === instance.isExposed(deviceId)) continue
      if (next) await this.exposeDevice(instance, String(deviceId))
      else await this.unexposeDevice(instance, String(deviceId))
    }
    return { success: true as const }
  }
}

export default ExportGoogleAddon
