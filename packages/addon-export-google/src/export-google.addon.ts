/**
 * Google Home Export addon — hub-side.
 *
 * Architecture:
 *
 *   Google Home / Assistant --HTTPS--> POST /addon/export-google/fulfillment
 *                                      (hub Fastify → addon-routes cap)
 *
 * There is no cloud function in the middle. Google's smart-home platform calls
 * the fulfillment URL the operator configured, so the hub answers directly —
 * a shorter path than Alexa's, which needs an operator-owned Lambda because
 * Amazon will only talk to a Lambda ARN.
 *
 * Capabilities registered:
 *   - `device-export`      — the operator picks which devices Google sees.
 *   - `addon-routes`       — mounts `/addon/export-google/fulfillment`.
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
import {
  type AddonInitResult,
  addonRoutesCapability,
  BaseAddon,
  buildAddonRouteProvider,
  type ConfigSectionWithValues,
  type ConfigUISchemaWithValues,
  deviceExportCapability,
  EventCategory,
  errMsg,
  type IAddonRouteProvider,
  type IDeviceExportProvider,
  type IOauthIntegrationProvider,
  oauthIntegrationCapability,
} from '@camstack/types'

import { exportGoogleActions } from './custom-actions.js'
import { createApiDeviceGateway, type DeviceGateway } from './device-gateway.js'
import type { VerifiedGoogleCaller } from './fulfillment-router.js'
import { SUPPORTED_DEVICE_KINDS } from './google-home/device-model.js'
import { traitsForCaps } from './google-home/trait-catalog.js'
import { buildRoutes } from './http-server.js'
import { buildGoogleOauthIntegration } from './oauth-integration.js'
import {
  buildConsoleSetup,
  buildPublicHubUrlNotice,
  describeDetectResult,
  detectPublicHubOrigins,
  type NetworkAccessReader,
  type PublicHubUrlState,
  refreshPublicHubUrl,
} from './public-hub-url.js'
import {
  DEFAULT_SETTINGS,
  type ExportSetup,
  type ExposedDeviceEntry,
  type GoogleExportSettings,
  type LinkedAccount,
} from './types.js'

const ADDON_ID = 'export-google'

/** Result of the "Detect external address" button. */
interface DetectPublicHubUrlResult {
  readonly publicHubUrl: string
  readonly detectedPublicHubUrl: string
  /** True when detection filled an empty field. False means it left one alone. */
  readonly filled: boolean
  readonly summary: string
}

export class ExportGoogleAddon extends BaseAddon<GoogleExportSettings> {
  private gateway: DeviceGateway | null = null

  constructor() {
    super({ ...DEFAULT_SETTINGS })
  }

  protected async onInitialize(): Promise<AddonInitResult<typeof exportGoogleActions>> {
    const gateway = createApiDeviceGateway({ api: this.ctx.api, logger: this.ctx.logger })
    this.gateway = gateway

    // Detached on purpose. This makes a cross-addon `ctx.api` call
    // (`networkAccess.*`); awaiting it inline is what left `export-alexa`
    // stuck in "Still waiting for capability" on a slow hub boot, because a
    // provider goes live only once `onInitialize` RETURNS. Nothing below reads
    // the result — every surface reads `this.config` lazily.
    void this.detectPublicHubUrl().catch((err: unknown) => {
      this.ctx.logger.warn('export-google: public hub URL auto-detect failed', {
        meta: { error: errMsg(err) },
      })
    })

    const deviceExportProvider: IDeviceExportProvider = {
      getStatus: async () => ({
        linkState: this.config.linkedAccounts.length > 0 ? 'linked' : 'unlinked',
        exposedDeviceCount: this.config.exposed.length,
        setup: this.buildSetupBlock(),
      }),
      listSupportedDeviceKinds: async () => [...SUPPORTED_DEVICE_KINDS],
      listExposedDevices: async () =>
        this.config.exposed.map((entry) => ({ deviceId: String(entry.deviceId) })),
      exposeDevice: async ({ deviceId }) => this.exposeDevice(deviceId),
      unexposeDevice: async ({ deviceId }) => this.unexposeDevice(deviceId),
      // `device-export` types deviceId as a string; our entries key on numbers.
      getDeviceSettingsContribution: (input) =>
        this.buildDeviceSettingsContribution(Number(input.deviceId)),
      getDeviceLiveContribution: async () => null,
      applyDeviceSettingsPatch: (input) =>
        this.applyDeviceSettingsPatch(Number(input.deviceId), input.patch),
    }

    const routes = buildRoutes({
      ctx: this.ctx,
      logger: this.ctx.logger,
      fulfillment: {
        logger: this.ctx.logger,
        sync: {
          gateway,
          logger: this.ctx.logger,
          // An in-process read of this addon's OWN store — no cap-router
          // round-trip for a value we already hold. Every OTHER reader of a
          // `device-export` exposed list pins by addonId.
          listExposed: () => this.config.exposed.map((entry) => entry.deviceId),
        },
        query: {
          gateway,
          logger: this.ctx.logger,
          isExposed: (deviceId) => this.isExposed(deviceId),
        },
        execute: {
          gateway,
          logger: this.ctx.logger,
          isExposed: (deviceId) => this.isExposed(deviceId),
        },
        recordLink: (caller) => this.recordLink(caller),
        removeLink: (userId) => this.removeLink(userId),
      },
    })
    const routeProvider: IAddonRouteProvider = buildAddonRouteProvider(ADDON_ID, routes)

    // Read on the authorize path, so the descriptor is static and this addon
    // must not register it behind an await — a provider goes live only once
    // `onInitialize` RETURNS.
    const oauthIntegrationProvider: IOauthIntegrationProvider = {
      getDescriptor: async () => buildGoogleOauthIntegration(),
    }

    // A remote-access provider (Cloudflare Tunnel, Tailscale Funnel) usually
    // connects AFTER this addon boots, so the detached detect above sees no
    // HTTPS endpoint and the field stays empty. Every tunnel provider emits
    // `NetworkTunnelStarted` the moment it connects; re-running detection then
    // is what turns "empty forever" into "empty until the tunnel is up".
    // Safe to repeat: detection only ever FILLS an empty field.
    const offTunnelStarted = this.ctx.eventBus.subscribe(
      { category: EventCategory.NetworkTunnelStarted },
      () => {
        void this.detectPublicHubUrl().catch((err: unknown) => {
          this.ctx.logger.warn('export-google: public hub URL detect after tunnel connect failed', {
            meta: { error: errMsg(err) },
          })
        })
      },
    )
    this.ctx.addDisposer(async () => offTunnelStarted())

    this.ctx.logger.info('export-google: initialized', {
      meta: {
        exposedCount: this.config.exposed.length,
        linkedAccounts: this.config.linkedAccounts.length,
        publicHubUrlSet: this.config.publicHubUrl.length > 0,
        // Stated in the boot log because it is the single most surprising
        // property of this addon: state reaches Google by polling only.
        willReportState: false,
      },
    })

    return {
      providers: [
        { capability: deviceExportCapability, provider: deviceExportProvider },
        { capability: addonRoutesCapability, provider: routeProvider },
        { capability: oauthIntegrationCapability, provider: oauthIntegrationProvider },
      ],
      customActions: exportGoogleActions,
      actionHandlers: {
        detectPublicHubUrl: async () => this.detectPublicHubUrl(),
      },
    }
  }

  // ── Public hub URL ──────────────────────────────────────────────

  /** This addon's slice of `PublicHubUrlState`. */
  private publicHubUrlState(): PublicHubUrlState {
    return {
      publicHubUrl: this.config.publicHubUrl,
      detectedPublicHubUrl: this.config.detectedPublicHubUrl,
    }
  }

  /**
   * Adapter from the codegen'd `network-access` router onto the narrow reader
   * `public-hub-url.ts` consumes. Fields are copied one by one rather than
   * passed through, so the module never depends on the cap's wider shape and a
   * test double for it needs no cast.
   */
  private networkAccessReader(): NetworkAccessReader {
    return {
      listEndpoints: async () => {
        const entries = await this.ctx.api.networkAccess.listEndpoints.query({})
        return entries.map((entry) => ({ url: entry.url, protocol: entry.protocol }))
      },
      getStatus: async () => {
        const status = await this.ctx.api.networkAccess.getStatus.query({})
        return {
          connected: status.connected,
          endpoint:
            status.endpoint === null
              ? null
              : { url: status.endpoint.url, protocol: status.endpoint.protocol },
        }
      },
    }
  }

  /**
   * Refresh the detected address and DEFAULT the field to it when it is empty.
   * Backs both the boot-time detect and the "Detect external address" button.
   *
   * Never replaces a value the operator set — that value is what they already
   * pasted into the Google console, and rewriting it here would leave the two
   * sides disagreeing with nothing on screen to say so.
   */
  private async detectPublicHubUrl(): Promise<DetectPublicHubUrlResult> {
    const resolution = await refreshPublicHubUrl({
      current: () => this.publicHubUrlState(),
      detect: () =>
        detectPublicHubOrigins({
          network: this.networkAccessReader(),
          logger: this.ctx.logger,
        }),
      persist: (patch) => this.updateGlobalSettings(patch),
      logger: this.ctx.logger,
    })
    const result = {
      publicHubUrl: resolution.publicHubUrl,
      detectedPublicHubUrl: resolution.detectedPublicHubUrl,
      filled: resolution.defaulted,
    }
    return { ...result, summary: describeDetectResult(result) }
  }

  protected override async onShutdown(): Promise<void> {
    this.gateway = null
  }

  // ── device-export ───────────────────────────────────────────────

  private isExposed(deviceId: number): boolean {
    return this.config.exposed.some((entry) => entry.deviceId === deviceId)
  }

  private async exposeDevice(deviceIdRaw: string): Promise<void> {
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
        meta: { deviceType: facts.deviceType, capNames: facts.capNames },
      })
      throw new Error(
        `export-google: device ${deviceId} has no capability this addon exports (bound: ${facts.capNames.join(', ') || 'none'})`,
      )
    }

    const next: ExposedDeviceEntry[] = this.config.exposed.filter((e) => e.deviceId !== deviceId)
    next.push({ deviceId, exposedAt: Date.now() })
    await this.updateGlobalSettings({ exposed: next })

    // Google learns about a new device only on its next SYNC, and the hub
    // cannot ASK for one: `requestSync` is a HomeGraph call and HomeGraph needs
    // the service-account key this addon deliberately does not hold. Say so on
    // the line an operator will read when the device fails to appear.
    this.ctx.logger.info(
      'export-google: exposed device — visible after the next Google SYNC ("Hey Google, sync my devices")',
      { tags: { deviceId } },
    )
  }

  private async unexposeDevice(deviceIdRaw: string): Promise<void> {
    const deviceId = Number.parseInt(deviceIdRaw, 10)
    if (!Number.isFinite(deviceId)) return
    const next = this.config.exposed.filter((e) => e.deviceId !== deviceId)
    if (next.length === this.config.exposed.length) return
    await this.updateGlobalSettings({ exposed: next })
    this.ctx.logger.info('export-google: unexposed device — removed from Google on its next SYNC', {
      tags: { deviceId },
    })
  }

  private requireGateway(): DeviceGateway {
    if (this.gateway === null) throw new Error('export-google: addon not initialized')
    return this.gateway
  }

  // ── Link bookkeeping ────────────────────────────────────────────

  private async recordLink(caller: VerifiedGoogleCaller): Promise<void> {
    if (this.config.linkedAccounts.some((account) => account.userId === caller.userId)) return
    const next: LinkedAccount[] = [
      ...this.config.linkedAccounts,
      { userId: caller.userId, username: caller.username, linkedAt: Date.now() },
    ]
    await this.updateGlobalSettings({ linkedAccounts: next })
    this.ctx.logger.info('export-google: recorded linked account', {
      meta: { userId: caller.userId },
    })
  }

  private async removeLink(userId: string): Promise<void> {
    const next = this.config.linkedAccounts.filter((account) => account.userId !== userId)
    if (next.length === this.config.linkedAccounts.length) return
    await this.updateGlobalSettings({ linkedAccounts: next })
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
  private buildSetupBlock(): ExportSetup {
    return buildConsoleSetup({
      addonId: ADDON_ID,
      ...this.publicHubUrlState(),
      linkedAccounts: this.config.linkedAccounts.length,
    })
  }

  protected globalSettingsSchema() {
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
                'Create a cloud-to-cloud integration in the Google Home Developer Console, paste the three URLs from the Export panel, and link your account from the Home app.',
                'Cameras are not exported, and state is not pushed: Google polls. Ask "Hey Google, sync my devices" after exposing something new.',
              ].join('\n'),
            },
            this.field({
              type: 'text',
              key: 'publicHubUrl',
              label: 'Public hub URL',
              description:
                'HTTPS origin Google reaches this hub on, e.g. https://hub.example.com. Used to render the URLs you paste into the Google console. Left empty, it defaults to the first external address remote access reports; once it holds a value, nothing overwrites it.',
              placeholder: 'https://hub.example.com',
              default: DEFAULT_SETTINGS.publicHubUrl,
            }),
            // The provenance line. A URL that appeared on its own with no
            // indication of where it came from is worse than a blank field —
            // the operator cannot tell whether it is the right one.
            {
              type: 'info' as const,
              key: '__public-hub-url-source',
              label: 'Where this came from',
              ...buildPublicHubUrlNotice(this.publicHubUrlState()),
            },
            {
              type: 'addon-action-button' as const,
              addonId: ADDON_ID,
              key: '__detect-public-hub-url',
              label: 'External address',
              description:
                'Re-scan the connected remote-access providers. Fills the field above when it is empty; a value you set is left exactly as it is.',
              buttonLabel: 'Detect external address',
              action: 'detectPublicHubUrl',
              variant: 'default' as const,
              successMessage: '{summary}',
            },
          ],
        },
      ],
    })
  }

  /**
   * Per-device "Export" panel. Offered only for devices this addon can actually
   * represent — a toggle on a camera would be a switch that promises something
   * `buildSyncDevice` then refuses.
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

    const enabled = this.isExposed(deviceId)
    const linked = this.config.linkedAccounts.length
    // Field keys are namespaced per exporter: the device-aggregate form
    // flattens fields by `key` across sections, so a bare `enabled` would
    // collide with HAP's and Alexa's and route this toggle to their writer.
    const enabledKey = `google:${deviceId}:enabled`
    const statusLabel = enabled
      ? `Exposed as ${descriptors.map((d) => d.trait.replace('action.devices.traits.', '')).join(' + ')}${
          linked > 0 ? `, ${linked} linked Google account(s)` : ' (no linked Google account yet)'
        }`
      : 'Not exposed'

    const section: ConfigSectionWithValues = {
      id: ADDON_ID,
      title: 'Google Home Export',
      description: 'Surface this device to the linked Google Home account.',
      tab: 'export',
      columns: 1,
      order: 30,
      fields: [
        {
          type: 'info' as const,
          key: '__google-status',
          label: 'Status',
          content: statusLabel,
          variant: 'info' as const,
        },
        {
          type: 'boolean' as const,
          key: enabledKey,
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
    }
    return {
      tabs: [{ id: 'export', label: 'Export', icon: 'share-2', order: 80 }],
      sections: [section],
    }
  }

  private async applyDeviceSettingsPatch(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<{ success: true }> {
    const enabledKey = `google:${deviceId}:enabled`
    if (!(enabledKey in patch)) return { success: true as const }
    const next = patch[enabledKey]
    if (typeof next !== 'boolean') {
      this.ctx.logger.warn('export-google: ignored export toggle — value was not a boolean', {
        tags: { deviceId },
      })
      return { success: true as const }
    }
    if (next === this.isExposed(deviceId)) return { success: true as const }
    if (next) await this.exposeDevice(String(deviceId))
    else await this.unexposeDevice(String(deviceId))
    return { success: true as const }
  }
}

export default ExportGoogleAddon
