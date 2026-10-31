import {
  AdoptionAdoptInputSchema,
  AdoptionAdoptResultSchema,
  AdoptionListCandidatesInputSchema,
  AdoptionListCandidatesOutputSchema,
  addonRoutesCapability,
  BaseDeviceProvider,
  bestLocationMatch,
  brokerCapability,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceSummary,
  DeviceType,
  type DiscoveryCandidate,
  deviceAdoptionCapability,
  errMsg,
  type IBrokerProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type INotificationOutputProvider,
  notificationOutputCapability,
  calendarSourceCapability,
  type ProviderRegistration,
  type SavedDevice,
  publicEndpointReaderFrom,
} from '@camstack/types'
import type { z } from 'zod'
import { HaContainerDevice } from './devices/ha-container-device.js'
import { HaEventBusDevice } from './devices/ha-event-bus-device.js'
import { cascadeRemoveDevicesForBroker } from './ha-broker-device-cascade.js'
import { markBrokerDevicesOffline } from './ha-broker-offline.js'
import { authToSettings, type HaBrokerEntry, HaBrokerRegistry } from './ha-broker-registry.js'
import { haBrokerSettingsSchema } from './ha-broker-settings-schema.js'
import { haDeviceToCandidate } from './ha-candidate-mapper.js'
import type { HaContainerEntityConfig } from './ha-container-reconcile.js'
import {
  buildContainerEntities,
  diffContainerEntities,
  parseContainerEntities,
} from './ha-container-reconcile.js'
import { readHaSource } from './ha-device-source.js'
import { buildDiscoveryCandidates } from './ha-discovery.js'
import {
  HA_ORPHAN_ENTITIES_DEVICE_ID,
  type HaDiscoveredDevice,
  type HaDiscoveredEntity,
  type HaEntityCategory,
} from './ha-discovery-types.js'
import { mapHaEntityToCamStack } from './ha-domain-mapping.js'
import { deriveIntegrationDomain } from './ha-integration-domain.js'
import type {
  HaBusEventEnvelope,
  PublishTargetHa,
  SubscribeFilterHa,
} from './ha-integration-manager.js'
import {
  createHaIconRouteProvider,
  HA_NOTIFICATION_ICON_MEDIA_TYPE,
  HA_NOTIFICATION_ICON_URL,
} from './ha-notification-icon.js'
import {
  createHaNotificationOutputProvider,
  HaTargetStore,
  type NotifyServiceData,
} from './ha-notification-output.js'
import { HaBrokerStore } from './ha-broker-store.js'
import { haAllRecordKinds } from './record-kinds.js'
import { createHaCalendarSource, listHaCalendarCatalog } from './ha-calendar-source.js'
import { reconcileBroker } from './ha-reconcile-broker.js'
import { computeBrokerCleanup, linkBrokersToIntegrations } from './ha-reconciler.js'
import {
  buildStandaloneEntityCandidates,
  buildStandaloneEntityConfig,
  generateStandaloneEntityStableId,
  partitionRestoreDevices,
  planStandaloneReconcile,
  standaloneEntityDeviceClass,
} from './ha-standalone-entity.js'
import type { HaEntityState } from './ha-types.js'

/** Reserved discovery granularity ids for the HA `device-adoption` provider.
 *  `devices` materialises one Container per HA device (the pre-existing path);
 *  `entities` imports a single HA entity as a standalone top-level device. */
const ADOPTION_FILTER_DEVICES = 'devices'
const ADOPTION_FILTER_ENTITIES = 'entities'

type ListCandidatesInput = z.infer<typeof AdoptionListCandidatesInputSchema>
type ListCandidatesOutput = z.infer<typeof AdoptionListCandidatesOutputSchema>
type AdoptInput = z.infer<typeof AdoptionAdoptInputSchema>
type AdoptResult = z.infer<typeof AdoptionAdoptResultSchema>
type AdoptedEntry = AdoptResult['adopted'][number]

const HA_KIND = 'home-assistant'

interface HaProviderConfig {
  readonly brokers: readonly HaBrokerEntry[]
  /**
   * HA `calendar.*` entity ids to expose via calendar-source. Empty = all
   * (legacy). Edited under Connectivity → Calendars → Home Assistant.
   */
  readonly calendarIds: readonly string[]
}

const DEFAULT_CONFIG: HaProviderConfig = { brokers: [], calendarIds: [] }

/**
 * Home Assistant provider addon.
 *
 * Registers two cap providers on top of the standard BaseAddon
 * lifecycle:
 *   - `broker` (kind: 'home-assistant') — unified pub/sub registry
 *     surface every HA-aware addon consumes for publish/subscribe/
 *     getState/callService.
 *   - `device-adoption` — generic discovery + adoption flow that the
 *     Integrations page UI drives (paginated candidate table +
 *     accordion + adopt/release buttons), backed by the HA discovery
 *     service.
 *
 * Adoption materialises `HaPlaceholderDevice` instances (one parent +
 * N accessory children per HA device). Phase F will replace the
 * placeholder with per-domain BaseDevice subclasses that register
 * the real cap providers (switch / brightness / temperature-sensor /
 * …) and route HA state pushes into runtime-state slices + cap
 * mutations into HA call_service.
 */
export class HaProviderAddon extends BaseDeviceProvider<HaProviderConfig> {
  // ── BaseDeviceProvider required abstract members ──────────────────────
  protected readonly addonId = 'provider-homeassistant'
  protected readonly providerName = 'Home Assistant'
  protected readonly deviceClasses = {
    [DeviceType.Container]: HaContainerDevice,
    // Generic per-broker bus-event aggregator (Case 2). Registered so the
    // default restore pass re-instantiates it on reboot (it is created via
    // `ensureEventBusDevice`, not entity-adoption).
    [DeviceType.EventEmitter]: HaEventBusDevice,
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    const integrationId =
      typeof config['integrationId'] === 'string' ? config['integrationId'] : undefined
    const name =
      typeof config['name'] === 'string'
        ? config['name']
        : String(config['haDeviceId'] ?? 'unknown')
    return {
      meta: {
        type,
        name,
        ...(integrationId !== undefined ? { integrationId } : {}),
      },
      config,
    }
  }

  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    return `ha:${String(config?.['brokerId'] ?? 'unknown')}:dev:${String(config?.['haDeviceId'] ?? Date.now())}`
  }

  // ── HA-specific state ─────────────────────────────────────────────────
  private registry: HaBrokerRegistry | null = null
  private brokerStore: HaBrokerStore | null = null
  /** Runtime broker rows (records when B2 is live, else settings). */
  private activeBrokers: readonly HaBrokerEntry[] = []
  /** Periodic re-sync sweep handle (cleared on shutdown). */
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  /** `brokerId → aggregator deviceId` cache for the per-broker generic
   *  `EventEmitter` device (Case 2). Populated by {@link ensureEventBusDevice};
   *  read by {@link routeBusEvent} to resolve the live device instance. */
  private readonly eventBusDeviceIds = new Map<string, number>()

  /** How often to re-align adopted Containers with the live HA mapping while a
   *  broker stays connected (the on-connect hook covers HA restarts/reconnects). */
  private static readonly RESYNC_INTERVAL_MS = 5 * 60_000

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('provider-homeassistant: ctx.records is required (hub-only addon)')
    }
    await records.declare(haAllRecordKinds)
    this.brokerStore = HaBrokerStore.of(records)
    this.activeBrokers = await this.loadPersistedBrokers()

    this.registry = new HaBrokerRegistry(this.ctx.logger, this.ctx.eventBus)
    // Re-sync adopted devices each time a broker (re)connects — this is the
    // HA-restart path (exactly when entity caps/classes change). Reconciles BOTH
    // Containers AND standalone entity devices off a single shared inventory
    // fetch. Registered BEFORE restore so brokers connecting during bootstrap
    // also fire it. Fire-and-forget; reconcile is best-effort.
    this.registry.setOnBrokerConnected((brokerId) => {
      void this.reconcileBroker(brokerId)
    })
    // Broker drop → mark this broker's child devices offline (A2). Children
    // come back online on their next real state push (A1 chokepoint) once the
    // broker reconnects and the re-subscribe replays each entity's state.
    this.registry.setOnBrokerDisconnected((brokerId) => {
      void this.markBrokerDevicesOffline(brokerId)
    })
    // Case 2: route every curated HA bus event onto the per-broker generic
    // EventEmitter aggregator. Registered BEFORE restore so events that arrive
    // while brokers connect during bootstrap are routed (best-effort dropped
    // until the aggregator device exists).
    this.registry.setOnBusEvent((brokerId, ev) => {
      void this.routeBusEvent(brokerId, ev)
    })
    await this.registry.restore(this.activeBrokers)

    // Periodic sweep — catches mapping changes that happen while connected
    // (and the first-boot case where devices restore after the initial connect).
    this.resyncTimer = setInterval(() => {
      void this.reconcileAllConnectedBrokers()
    }, HaProviderAddon.RESYNC_INTERVAL_MS)
    this.ctx.logger.info('ha provider initialised', {
      meta: {
        brokerCount: this.activeBrokers.length,
      },
    })

    // Sync integration records → broker entries (initial reconcile +
    // event-driven on integration lifecycle changes).
    await this.reconcileIntegrationsToBrokers()
    this.subscribeIntegrationLifecycle()

    return [
      { capability: brokerCapability, provider: this.buildBrokerProvider() },
      { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
      {
        capability: notificationOutputCapability,
        provider: await this.buildNotificationOutputProvider(),
      },
      // Serve the bundled Home Assistant brand icon over the addon's own HTTP
      // surface (`GET /addon/provider-homeassistant/icons/homeassistant`). The
      // notification-output provider stamps the matching `iconUrl` onto its
      // `homeassistant` kind descriptor.
      { capability: addonRoutesCapability, provider: createHaIconRouteProvider() },
      {
        capability: calendarSourceCapability,
        provider: createHaCalendarSource({
          brokers: this.requireRegistry(),
          logger: this.ctx.logger.child('calendar-source'),
          selectedCalendarIds: () => new Set(this.config.calendarIds ?? []),
        }),
      },
    ]
  }

  // ── notification-output cap provider (T13) ───────────────────────────
  //
  // A SECOND `notification-output` collection provider (the first lives in the
  // system `addon-notifiers`). Contributes exactly one kind — `homeassistant` —
  // to the concat-fanned catalog. Delivery reuses the HA broker WS:
  // `send` → `notify.<service>` `call_service`; discovery → `get_services`.
  private async buildNotificationOutputProvider(): Promise<INotificationOutputProvider> {
    // `execution.placement: hub-only` guarantees ctx.records is present.
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('ha notification-output: ctx.records is required (hub-only addon)')
    }
    // Declare ha-notification-targets BEFORE first store access.
    const store = HaTargetStore.of(records)
    return createHaNotificationOutputProvider({
      addonId: this.ctx.id,
      iconUrl: HA_NOTIFICATION_ICON_URL,
      iconMediaType: HA_NOTIFICATION_ICON_MEDIA_TYPE,
      store,
      publish: async (brokerId: string, service: string, serviceData: NotifyServiceData) => {
        await this.requireRegistry().publish(brokerId, { domain: 'notify', service }, serviceData)
      },
      getServices: async (brokerId: string) => {
        const manager = this.requireRegistry().getManager(brokerId)
        if (!manager) throw new Error(`ha-broker '${brokerId}' not found`)
        return manager.sendMessage({ type: 'get_services' })
      },
      listDevices: async (brokerId: string) => {
        const manager = this.requireRegistry().getManager(brokerId)
        if (!manager) throw new Error(`ha-broker '${brokerId}' not found`)
        return manager.sendMessage({ type: 'config/device_registry/list' })
      },
      listBrokerIds: () => this.activeBrokers.map((b) => b.id),
      readPublicEndpoint: publicEndpointReaderFrom(this.ctx.api.localNetwork),
      logger: this.ctx.logger.child('notification-output'),
    })
  }

  // ── device-provider discovery + adoption ─────────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async discoverDevices(): Promise<readonly DiscoveryCandidate[]> {
    const out: DiscoveryCandidate[] = []
    for (const { brokerId, integrationId, manager } of this.requireRegistry().listManagers()) {
      const [devices, entities] = await Promise.all([
        manager.sendMessage<readonly Record<string, unknown>[]>({
          type: 'config/device_registry/list',
        }),
        manager.sendMessage<readonly Record<string, unknown>[]>({
          type: 'config/entity_registry/list',
        }),
      ])
      out.push(
        ...buildDiscoveryCandidates({
          brokerId,
          integrationId,
          devices,
          entities,
          states: manager.snapshotAllStates(),
        }),
      )
    }
    return out
  }

  override async adoptDiscoveredDevice({
    candidate,
  }: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    return this.createDevice({
      type: candidate.type,
      config: { ...candidate.prefilledConfig, name: candidate.suggestedName },
    })
  }

  /**
   * Mirror integration records → broker entries (Approach A).
   *
   * Under Approach A an integration record carries ONLY a `{brokerId}`
   * link to a row in the addon's `config.brokers[]`. Brokers are created
   * out-of-band via the `broker.add` cap (the wizard UI), NOT by this
   * reconciler cramming credentials into the integration. So this pass
   * does exactly two things:
   *
   *   - **Link**: for each surviving integration whose settings carry a
   *     `{brokerId}` pointing at a live broker, record the
   *     `integrationId → brokerId` link in the registry so the generic
   *     `device-adoption` cap can resolve the broker.
   *   - **Cleanup**: drop any broker that was spawned by an integration
   *     (carries an `integrationId` FK) once no surviving integration
   *     references it. Manually-created brokers (no FK) are never
   *     auto-removed.
   *
   * Idempotent — runs on boot + on every integration.* event.
   */
  private async reconcileIntegrationsToBrokers(): Promise<void> {
    type IntegrationApi = {
      integrations?: {
        list?: {
          query: () => Promise<
            readonly { id: string; addonId: string; name: string; enabled: boolean }[]
          >
        }
        getSettings?: { query: (input: { id: string }) => Promise<Record<string, unknown>> }
      }
    }
    const api = this.ctx.api as IntegrationApi
    if (!api.integrations?.list?.query || !api.integrations.getSettings?.query) {
      return
    }
    try {
      const all = await api.integrations.list.query()
      const haIntegrations = all.filter((i) => i.addonId === this.ctx.id)
      const survivingIntegrationIds = new Set(haIntegrations.map((i) => i.id))

      // ── Link: tag each integration's referenced broker ─────────────
      // Builds the in-memory registry index AND collects the
      // integration→brokerId pairs used to persist the FK below.
      const integrationsWithBrokerId: { id: string; brokerId: string | undefined }[] = []
      for (const integration of haIntegrations) {
        const settings = await api.integrations.getSettings.query({ id: integration.id })
        const brokerId = typeof settings['brokerId'] === 'string' ? settings['brokerId'] : null
        if (!brokerId) continue
        const matching = this.activeBrokers.find((b) => b.id === brokerId)
        if (!matching) {
          this.ctx.logger.warn('integration→broker: linked broker not found', {
            meta: { integrationId: integration.id, brokerId },
          })
          continue
        }
        this.requireRegistry().linkIntegration(integration.id, brokerId)
        integrationsWithBrokerId.push({ id: integration.id, brokerId })
      }

      // ── Persist FK: stamp integrationId onto each linked broker so the
      //    cleanup-on-delete pass (below + future runs) can collect
      //    orphans. Wizard-created brokers start with no FK; without this
      //    they would leak forever. Re-reads this.activeBrokers after the
      //    write so the cleanup pass sees the freshly-stamped FKs.
      const linkedBrokers = linkBrokersToIntegrations(this.activeBrokers, integrationsWithBrokerId)
      const fkChanged = linkedBrokers.some((b, i) => b !== this.activeBrokers[i])
      if (fkChanged) {
        await this.persistBrokerEntries(linkedBrokers)
      }

      // ── Orphans are REPORTED, never removed ────────────────────────
      //
      // This pass used to delete every broker whose `integrationId` was not in
      // `survivingIntegrationIds`, and write the survivors back. On
      // 2026-08-05 that destroyed the operator's Home Assistant connection: a
      // reconcile ran while the hub was still restarting, `integrations.list`
      // answered with an EMPTY array rather than throwing, so no integration
      // "survived" and every broker was deleted and the empty list persisted.
      // The doorbell went dead and the config — host AND token — was
      // unrecoverable, because nothing in this addon can rebuild a broker from
      // an integration record.
      //
      // A guard against an empty list would have been the narrow fix. The
      // operator's instruction is broader and better: **never delete a broker
      // automatically.** A stale broker entry costs a row and a log line; a
      // deleted one costs a credential nobody has a copy of. Removing one is an
      // operator action, through the integration delete path.
      const orphans = computeBrokerCleanup(this.activeBrokers, survivingIntegrationIds)
      this.ctx.logger.info('integration→broker reconcile', {
        meta: {
          brokerCount: this.activeBrokers.length,
          integrationCount: haIntegrations.length,
          orphans: orphans.length,
        },
      })
      if (orphans.length > 0) {
        // Named, so an operator who wants them gone knows exactly which.
        this.ctx.logger.warn('broker entries have no surviving integration — KEPT', {
          meta: { brokerIds: orphans, integrationCount: haIntegrations.length },
        })
      }
    } catch (err) {
      this.ctx.logger.warn('integration→broker reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const eb = this.ctx.eventBus
    const handler = (event: { data?: unknown }): void => {
      const data = event.data as { addonId?: string } | undefined
      if (data?.addonId !== this.ctx.id) return
      // Fire-and-forget — reconcile runs the full sync; transient
      // races resolve on the next event.
      void this.reconcileIntegrationsToBrokers()
    }
    eb.subscribe({ category: 'integration.enabled' }, handler)
    eb.subscribe({ category: 'integration.disabled' }, handler)
    eb.subscribe({ category: 'integration.deleted' }, handler)
  }

  // ── Settings UI (External systems → integration settings panel) ────
  //
  // Approach A: an integration record carries ONLY a `{brokerId}` link;
  // it never stores credentials. Brokers are created/edited via the
  // `broker.add` cap from the wizard (External systems → Brokers), NOT
  // by cramming a creation form into the integration settings. So this
  // schema is purely informational — there are no editable fields.

  protected globalSettingsSchema(cap?: string) {
    if (cap === 'calendar-source') {
      return this.schema({
        sections: [
          {
            id: 'ha-calendars-import',
            title: 'Calendars to import',
            titleKey: 'provider-homeassistant:globalSettings.s_ha-calendars-import.title',
            columns: 1,
            fields: [
              {
                type: 'multiselect' as const,
                key: 'calendarIds',
                label: 'Calendars',
                labelKey:
                  'provider-homeassistant:globalSettings.s_ha-calendars-import.calendarIds.label',
                options: [] as const,
                optionsFrom: '_calendarCatalog',
                description:
                  'Discovered from connected HA brokers. Select at least one to import; leave empty to import none.',
                descriptionKey:
                  'provider-homeassistant:globalSettings.s_ha-calendars-import.calendarIds.description',
              },
            ],
          },
        ],
      })
    }
    return this.schema({
      sections: [
        {
          id: 'ha-broker',
          title: 'Home Assistant broker',
          titleKey: 'provider-homeassistant:globalSettings.s_ha-broker.title',
          columns: 1,
          fields: [
            {
              type: 'info' as const,
              key: 'brokerHelp',
              label: 'Brokers are managed separately',
              labelKey: 'provider-homeassistant:globalSettings.s_ha-broker.brokerHelp.label',
              content:
                'This integration links to a Home Assistant broker managed under Connectivity → Brokers.',
            },
          ],
        },
      ],
    })
  }

  override async getGlobalSettings(
    overlay?: Record<string, unknown>,
    cap?: string,
    nodeId?: string,
  ) {
    if (cap !== 'calendar-source') {
      return super.getGlobalSettings(overlay, cap, nodeId)
    }
    const catalog = this.registry ? listHaCalendarCatalog(this.registry) : []
    return super.getGlobalSettings(
      {
        ...overlay,
        calendarIds: this.config.calendarIds ?? [],
        ...(catalog.length > 0 ? { _calendarCatalog: catalog } : {}),
      },
      cap,
      nodeId,
    )
  }

  protected override async onShutdown(): Promise<void> {
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer)
      this.resyncTimer = null
    }
    // Shut down the HA broker registry (WebSocket connections) before
    // the BaseDeviceProvider teardown decommissions devices.
    try {
      await this.registry?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('ha provider shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.registry = null
    // BaseDeviceProvider.onShutdown decommissions every device this
    // provider owns — call it after the registry teardown so devices
    // are properly cleaned up.
    await super.onShutdown()
  }

  /**
   * Reconcile the live broker registry against the persisted `brokers`
   * array. Called by BaseAddon after every `updateGlobalSettings` /
   * `updateAddonSettings` — covers BOTH paths that mutate the array:
   *
   *   1. `broker.add` / `broker.remove` / `broker.setSettings` cap
   *      methods: the registry is mutated IN-PLACE first (the cap
   *      provider does it), then `updateGlobalSettings` lands the
   *      persistence. This reconcile becomes a no-op (the registry
   *      already reflects the new state).
   *   2. UI form save (External systems → Brokers → HA settings → save):
   *      persistence is mutated first by the framework — the registry
   *      is stale. This reconcile starts managers for new entries,
   *      stops them for removed entries, and applies auth updates.
   */
  protected override async onConfigChanged(): Promise<void> {
    const reg = this.registry
    if (!reg) return
    this.activeBrokers = await this.loadPersistedBrokers()
    const persisted = this.activeBrokers
    const liveIds = new Set(reg.list().map((b) => b.id))
    const persistedIds = new Set(persisted.map((e) => e.id))

    // Remove managers whose persistence row was deleted.
    for (const liveId of liveIds) {
      if (!persistedIds.has(liveId)) {
        try {
          await reg.removeEntry(liveId)
        } catch (err) {
          this.ctx.logger.warn('ha onConfigChanged: removeEntry failed', {
            meta: { brokerId: liveId, error: errMsg(err) },
          })
        }
      }
    }

    // Start managers for newly-added persistence rows + apply auth
    // updates to existing ones. Rows added via the Settings form
    // arrive without an id (the field is hidden); we stamp the
    // registry-allocated id back into the persistence row below.
    for (const entry of persisted) {
      if (entry.id && liveIds.has(entry.id)) {
        // Existing manager — apply auth in case it changed via form
        // save. updateEntry is a no-op when the auth payload is
        // unchanged because the WS client compares before reconnect.
        try {
          // Project the entry's auth back to the settings shape the
          // registry expects (kind-discriminated payload).
          const settings =
            entry.auth.kind === 'supervisor'
              ? { supervisorToken: entry.auth.supervisorToken }
              : { baseUrl: entry.auth.baseUrl, accessToken: entry.auth.accessToken }
          await reg.updateEntry(entry.id, settings)
        } catch (err) {
          this.ctx.logger.warn('ha onConfigChanged: updateEntry failed', {
            meta: { brokerId: entry.id, error: errMsg(err) },
          })
        }
        continue
      }
      // New entry — start the manager. We can't use `createEntry`
      // because that allocates a fresh id; here we want to keep the
      // operator-supplied (or framework-assigned) id from the
      // persistence row. Build the registry entry directly.
      try {
        const settings =
          entry.auth.kind === 'supervisor'
            ? { supervisorToken: entry.auth.supervisorToken }
            : { baseUrl: entry.auth.baseUrl, accessToken: entry.auth.accessToken }
        // createEntry generates a new id — call the lower-level
        // ensureEntry path. To keep the public surface small, we
        // delegate by reusing createEntry then patching the id back
        // into the persistence row.
        const created = await reg.createEntry(entry.name, settings)
        if (created.id !== entry.id) {
          // Heal the persistence row id mismatch — the form-emitted
          // row may have come in with an empty `id` field that
          // BaseAddon's array reconciler kept as empty string. Swap
          // it for the registry's freshly-allocated id.
          const next = persisted.map((b) => (b === entry ? { ...b, id: created.id } : b))
          await this.persistBrokerEntries(next)
        }
      } catch (err) {
        this.ctx.logger.warn('ha onConfigChanged: failed to start new broker', {
          meta: { brokerName: entry.name, error: errMsg(err) },
        })
      }
    }
  }

  private async loadPersistedBrokers(): Promise<readonly HaBrokerEntry[]> {
    const store = this.brokerStore
    if (store !== null) {
      const fromRecords = await store.listResolved()
      if (fromRecords.length > 0) return fromRecords
    }
    return this.config.brokers
  }

  private async persistBrokerEntries(entries: readonly HaBrokerEntry[]): Promise<void> {
    this.activeBrokers = [...entries]
    const store = this.brokerStore
    if (store !== null) {
      await store.replaceAll(entries)
      return
    }
    await this.updateGlobalSettings({ brokers: entries })
  }

  // ── broker cap provider ──────────────────────────────────────────────

  private buildBrokerProvider(): IBrokerProvider {
    // The owning addon id — stamped onto every BrokerInfo this provider
    // returns so the admin UI threads it back as the `{ addonId }`
    // system-collection selector, routing id-keyed calls to THIS
    // provider instead of defaulting to the first-registered one.
    const ownerAddonId = this.ctx.id
    // True when this provider's registry owns the given id. Id-keyed
    // methods return null / no-op for foreign ids (NOT throw) so the
    // no-addonId collection fallback (which targets the first provider)
    // degrades gracefully instead of surfacing a wrong-provider error.
    const owns = (id: string): boolean => this.activeBrokers.some((b) => b.id === id)

    return {
      list: async ({ kind }) => {
        if (kind && kind !== HA_KIND) return []
        return this.requireRegistry()
          .list()
          .map((info) => ({ ...info, addonId: ownerAddonId }))
      },
      get: async ({ id }) => {
        const info = this.requireRegistry().get(id)
        return info ? { ...info, addonId: ownerAddonId } : null
      },
      listProviders: async () => [
        { addonId: ownerAddonId, kinds: [{ kind: HA_KIND, label: 'Home Assistant' }] },
      ],
      add: async ({ kind, name, settings, id }) => {
        if (kind !== HA_KIND) {
          throw new Error(
            `provider-homeassistant: only kind '${HA_KIND}' is handled here (got '${kind}')`,
          )
        }
        // `id` present = restoring a broker that was lost, under its ORIGINAL
        // id, so its devices reconnect instead of needing re-discovery. The
        // registry refuses an id that is still in use.
        const entry = await this.requireRegistry().createEntry(
          name,
          settings,
          id !== undefined ? { id } : {},
        )
        if (id !== undefined) {
          this.ctx.logger.info('broker restored under an adopted id', {
            meta: { brokerId: entry.id, name },
          })
        }
        await this.persistBrokerEntries([...this.activeBrokers, entry])
        return { id: entry.id }
      },
      remove: async ({ id }) => {
        // No-op for ids this provider does not own — the collection
        // fallback may route a foreign id here.
        if (!owns(id)) return
        await this.requireRegistry().removeEntry(id)
        // Cascade-delete all adopted devices whose source brokerId matches.
        // devices.remove cascades to children and emits device.unregistered per removed device.
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (reg && devices) {
          await cascadeRemoveDevicesForBroker({
            reg,
            devices,
            addonId: this.ctx.id,
            brokerId: id,
            logger: this.ctx.logger,
          })
        }
        const nextBrokers = this.activeBrokers.filter((b) => b.id !== id)
        await this.persistBrokerEntries(nextBrokers)
      },
      testConnection: async ({ id }) => {
        if (!owns(id)) return { ok: false, error: 'unknown broker' }
        const info = this.requireRegistry().get(id)
        if (!info) return { ok: false, error: 'unknown broker' }
        if (info.status === 'connected') {
          return {
            ok: true,
            latencyMs: info.lastCheckedAt ? Math.max(0, Date.now() - info.lastCheckedAt) : 0,
          }
        }
        return { ok: false, error: info.error ?? `status: ${info.status}` }
      },
      getSettings: async ({ id }) => {
        const entry = this.activeBrokers.find((b) => b.id === id)
        if (!entry) return null
        return authToSettings(entry.auth)
      },
      setSettings: async ({ id, settings }) => {
        if (!owns(id)) return
        const entry = await this.requireRegistry().updateEntry(id, settings)
        const next = this.activeBrokers.map((b) => (b.id === id ? entry : b))
        await this.persistBrokerEntries(next)
      },
      getBrokerConfig: async ({ id }) => {
        const entry = this.activeBrokers.find((b) => b.id === id)
        if (!entry) return null
        return authToSettings(entry.auth)
      },
      getSettingsSchema: async ({ kind }) => {
        if (kind !== HA_KIND) return null
        return haBrokerSettingsSchema
      },
      testSettings: async ({ kind, settings }) => {
        if (kind !== HA_KIND) return { ok: false, error: `unsupported kind: ${kind}` }
        return this.requireRegistry().testSettings(settings)
      },
      publish: async ({ brokerId, target, payload }) => {
        return this.requireRegistry().publish(brokerId, coerceHaTarget(target), payload)
      },
      subscribe: async ({ brokerId, filter }) => {
        return this.requireRegistry().subscribe(brokerId, coerceHaFilter(filter))
      },
      unsubscribe: async ({ brokerId, subscriptionId }) => {
        return this.requireRegistry().unsubscribe(brokerId, subscriptionId)
      },
      getState: async ({ brokerId, key }) => {
        return this.requireRegistry().getState(brokerId, key)
      },
      getStatus: async () => ({
        brokerCount: this.requireRegistry().size(),
        connectedCount: this.requireRegistry().connectedSize(),
      }),
    }
  }

  // ── device-adoption cap provider ─────────────────────────────────────
  //
  // Thin handlers delegating to the standard BaseDeviceProvider lifecycle:
  //   - listCandidates / getCandidate: fetch live HA inventory and map to
  //     DiscoveredChildDevice via haDeviceToCandidate.
  //   - adopt: calls this.createDevice(Container, config) per candidate —
  //     the standard path that spawns HaContainerDevice + accessory children.
  //   - release: calls kernel.devices.remove(parentDeviceId) — permanent.
  //   - refresh / getStatus: synthesised from live HA inventory.

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    const brokerFor = (integrationId: string): string =>
      this.requireRegistry().getBrokerIdByIntegrationId(integrationId)

    return {
      getStatus: async () => {
        // Aggregate status across all linked brokers.
        const managers = this.requireRegistry().listManagers()
        let candidateCount = 0
        let lastDiscoveryAt: number | null = null
        let lastError: string | null = null
        for (const { brokerId } of managers) {
          try {
            const devices = await this.fetchHaDiscoveredDevices(brokerId)
            // Orphan-entity synthetic bucket is Entities-tab only — omit from
            // the Devices candidate count.
            candidateCount += devices.filter(
              (d) => d.haDeviceId !== HA_ORPHAN_ENTITIES_DEVICE_ID,
            ).length
            const refreshedAt = Date.now()
            if (lastDiscoveryAt === null || refreshedAt > lastDiscoveryAt) {
              lastDiscoveryAt = refreshedAt
            }
          } catch (err) {
            lastError = errMsg(err)
          }
        }
        const allDevices = await this.ctx.kernel.devices.getAll()
        const adoptedCount = allDevices.filter(
          (d) =>
            d.parentDeviceId === null && String(d.config.get('system') ?? '') === 'homeassistant',
        ).length
        return { lastDiscoveryAt, candidateCount, adoptedCount, lastError }
      },

      refresh: async ({ integrationId }) => {
        const brokerId = brokerFor(integrationId)
        const devices = await this.fetchHaDiscoveredDevices(brokerId)
        const allDevices = await this.ctx.kernel.devices.getAll()
        const adoptedCount = allDevices.filter(
          (d) =>
            d.parentDeviceId === null && String(d.config.get('system') ?? '') === 'homeassistant',
        ).length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount: devices.filter((d) => d.haDeviceId !== HA_ORPHAN_ENTITIES_DEVICE_ID)
            .length,
          adoptedCount,
          lastError: null,
        }
      },

      // HA declares two discovery granularities: `devices` (one Container per HA
      // device, the default) and `entities` (one standalone top-level device per
      // HA entity).
      listCandidateFilters: async () => ({
        filters: [
          { id: ADOPTION_FILTER_DEVICES, label: 'Devices', isDefault: true },
          { id: ADOPTION_FILTER_ENTITIES, label: 'Entities' },
        ],
      }),

      listCandidates: async ({ integrationId, page, pageSize, filter, filterText }) => {
        // Branch on the granularity `filter`: the `entities` granularity returns
        // a flat per-entity candidate list; `devices` (or undefined) keeps the
        // pre-existing device-candidate path below.
        if (filter === ADOPTION_FILTER_ENTITIES) {
          return this.listEntityCandidates({ integrationId, page, pageSize, filterText })
        }
        const brokerId = brokerFor(integrationId)
        const allDevices = await this.ctx.kernel.devices.getAll()
        // Build a set of adopted haDeviceIds for marking candidates.
        const adoptedHaDeviceIds = new Set<string>()
        for (const d of allDevices) {
          if (d.parentDeviceId !== null) continue
          const haDeviceId = d.config.get('haDeviceId')
          if (typeof haDeviceId === 'string') adoptedHaDeviceIds.add(haDeviceId)
        }

        let haDevices = await this.fetchHaDiscoveredDevices(brokerId)
        // Synthetic orphan bucket is for the Entities tab only.
        haDevices = haDevices.filter((d) => d.haDeviceId !== HA_ORPHAN_ENTITIES_DEVICE_ID)
        // Mark alreadyAdopted based on current registry state.
        haDevices = haDevices.map((dev) => ({
          ...dev,
          alreadyAdopted: adoptedHaDeviceIds.has(dev.haDeviceId),
        }))

        // Apply text/query filters (the candidate-list narrowing, distinct
        // from the granularity `filter`).
        if (filterText?.search) {
          const q = filterText.search.toLowerCase()
          haDevices = haDevices.filter(
            (d) =>
              d.name.toLowerCase().includes(q) ||
              (d.manufacturer ?? '').toLowerCase().includes(q) ||
              (d.model ?? '').toLowerCase().includes(q),
          )
        }
        if (filterText?.area) {
          const area = filterText.area
          haDevices = haDevices.filter((d) => d.area === area)
        }
        if (filterText?.manufacturer) {
          const m = filterText.manufacturer
          haDevices = haDevices.filter((d) => d.manufacturer === m)
        }
        if (filterText?.adoptedOnly === true) {
          haDevices = haDevices.filter((d) => d.alreadyAdopted)
        }
        if (filterText?.unadoptedOnly === true) {
          haDevices = haDevices.filter((d) => !d.alreadyAdopted)
        }

        const totalCount = haDevices.length
        const start = (page - 1) * pageSize
        const slice = haDevices.slice(start, start + pageSize)
        return {
          candidates: slice.map(haDeviceToCandidate),
          totalCount,
          page,
          pageSize,
        }
      },

      getCandidate: async ({ integrationId, childNativeId }) => {
        const brokerId = brokerFor(integrationId)
        const allDevices = await this.ctx.kernel.devices.getAll()
        const adoptedHaDeviceIds = new Set<string>()
        for (const d of allDevices) {
          if (d.parentDeviceId !== null) continue
          const haDeviceId = d.config.get('haDeviceId')
          if (typeof haDeviceId === 'string') adoptedHaDeviceIds.add(haDeviceId)
        }
        const haDevices = await this.fetchHaDiscoveredDevices(brokerId)
        if (childNativeId === HA_ORPHAN_ENTITIES_DEVICE_ID) return null
        const found = haDevices.find((d) => d.haDeviceId === childNativeId) ?? null
        if (!found) return null
        const withAdoption = { ...found, alreadyAdopted: adoptedHaDeviceIds.has(found.haDeviceId) }
        return haDeviceToCandidate(withAdoption)
      },

      adopt: async ({ integrationId, childNativeIds, filter, perCandidate, importLocations }) => {
        // The `entities` granularity imports each entity as a standalone
        // top-level device; `devices` (or undefined) keeps the Container path.
        if (filter === ADOPTION_FILTER_ENTITIES) {
          return this.adoptStandaloneEntities({
            integrationId,
            childNativeIds,
            filter,
            perCandidate,
            importLocations,
          })
        }
        const brokerId = brokerFor(integrationId)
        // Fetch inventory once for all child ids to avoid redundant WS calls.
        const haDevices = await this.fetchHaDiscoveredDevices(brokerId)
        const haDeviceMap = new Map(haDevices.map((d) => [d.haDeviceId, d]))

        // Curated location registry, fetched ONCE per adopt call (only when
        // location import is requested). Threaded through the loop so a label
        // created for an earlier candidate is reused for a later one.
        let knownLocations: readonly string[] =
          importLocations === true ? await this.ctx.api.deviceManager.listLocations.query() : []

        // Every top-level HA device already adopted on this broker, keyed by the
        // stableId `createDevice` would generate. Adoption is RE-RUN constantly:
        // a batch that overran the transport deadline leaves the operator with
        // no idea which candidates landed, so their only recourse is to submit
        // the same list again. Without this map that retry throws
        // `Device numeric id N already registered` for every candidate that
        // succeeded, and when ALL of them succeeded the whole call fails with
        // "all N adopt(s) failed" — which reads as "nothing worked" when in
        // truth everything did.
        const existingByStableId = new Map<string, IDevice>()
        for (const dev of await this.ctx.kernel.devices.getAll()) {
          if (dev.parentDeviceId !== null) continue
          existingByStableId.set(dev.stableId, dev)
        }

        const adopted: AdoptedEntry[] = []
        let failures = 0
        let reused = 0

        for (const haDeviceId of childNativeIds) {
          try {
            if (haDeviceId === HA_ORPHAN_ENTITIES_DEVICE_ID) {
              throw new Error(
                'orphan entity bucket is not adoptable as a device — use the Entities tab',
              )
            }
            const haDevice = haDeviceMap.get(haDeviceId)
            const pc = perCandidate?.[haDeviceId]
            const deviceName = pc?.name ?? haDevice?.name ?? haDeviceId

            // Re-adopting an already-adopted candidate is a NO-OP that returns
            // the device it already has — never a duplicate, never an error the
            // operator has to interpret.
            const existing = existingByStableId.get(`ha:${brokerId}:dev:${haDeviceId}`)
            if (existing) {
              const kids = await this.ctx.kernel.devices.getChildren(existing.id)
              adopted.push({
                childNativeId: haDeviceId,
                parentDeviceId: existing.id,
                accessoryDeviceIds: kids.map((c) => c.id),
              })
              reused += 1
              this.ctx.logger.info('ha-adoption: candidate already adopted — returning existing', {
                tags: { deviceId: existing.id, integrationId },
                meta: { brokerId, haDeviceId, accessories: kids.length },
              })
              continue
            }

            // Build Container config matching HaContainerDevice's schema. The
            // same converter drives the reconcile path so the two never diverge.
            const entities = haDevice ? buildContainerEntities(haDevice) : []

            const containerConfig: Record<string, unknown> = {
              system: 'homeassistant',
              brokerId,
              haDeviceId,
              integrationId,
              entities,
              name: deviceName,
            }

            const summary: DeviceSummary = await this.createDevice({
              type: DeviceType.Container,
              config: containerConfig,
            })

            // Fetch children that were auto-spawned by getAccessoryChildren().
            const children = await this.ctx.kernel.devices.getChildren(summary.id)
            const accessoryDeviceIds = children.map((c) => c.id)

            // Best-effort: assign the imported source area as the device's
            // location. NEVER fails the adopt (the helper swallows errors).
            if (importLocations === true && haDevice?.area != null) {
              knownLocations = await this.assignImportedLocation(
                summary.id,
                haDevice.area,
                knownLocations,
              )
            }

            adopted.push({
              childNativeId: haDeviceId,
              parentDeviceId: summary.id,
              accessoryDeviceIds,
            })
            // Every candidate that LANDS says so, with the numeric id. This is
            // the only record of which of a 25-device batch actually made it
            // when the caller's request deadline expires mid-loop — the work
            // continues after the caller gives up, so the response cannot be
            // the answer and the log has to be.
            this.ctx.logger.info('ha-adoption: candidate adopted', {
              tags: { deviceId: summary.id, integrationId },
              meta: {
                brokerId,
                haDeviceId,
                accessories: accessoryDeviceIds.length,
                index: adopted.length,
                of: childNativeIds.length,
              },
            })
          } catch (err) {
            failures += 1
            this.ctx.logger.warn('ha-adoption: adopt failed for candidate (skipped)', {
              tags: { integrationId },
              meta: { brokerId, haDeviceId, error: errMsg(err) },
            })
          }
        }

        this.ctx.logger.info('ha-adoption: adopt batch finished', {
          tags: { integrationId },
          meta: {
            brokerId,
            requested: childNativeIds.length,
            created: adopted.length - reused,
            alreadyAdopted: reused,
            failed: failures,
          },
        })

        // Only throw when every id failed — partial success returns the ones
        // that worked.
        if (failures > 0 && adopted.length === 0) {
          throw new Error(
            `ha-adoption: all ${failures} adopt(s) failed for integration '${integrationId}'`,
          )
        }

        return { adopted }
      },

      release: async ({ camDeviceId }) => {
        // Permanent removal — cascades into all accessory children.
        await this.ctx.kernel.devices.remove(camDeviceId)
      },

      resync: async ({ camDeviceId }) => {
        // On-demand re-alignment of one adopted device with the live HA mapping.
        const all = await this.ctx.kernel.devices.getAll()
        const device = all.find((d) => d.id === camDeviceId) ?? null
        if (!device) throw new Error(`resync: device ${camDeviceId} not found`)
        if (device.config.get('system') !== 'homeassistant') {
          throw new Error(`resync: device ${camDeviceId} is not a Home Assistant device`)
        }
        const brokerId = device.config.get('brokerId')
        const haDeviceId = device.config.get('haDeviceId')
        if (typeof brokerId !== 'string' || typeof haDeviceId !== 'string') {
          throw new Error(`resync: device ${camDeviceId} missing brokerId/haDeviceId`)
        }
        const haDevices = await this.fetchHaDiscoveredDevices(brokerId)
        const haDevice = haDevices.find((d) => d.haDeviceId === haDeviceId) ?? null
        if (!haDevice) {
          throw new Error(
            `resync: HA device '${haDeviceId}' no longer present on broker '${brokerId}'`,
          )
        }
        return this.reconcileContainer(device, haDevice)
      },
    }
  }

  /**
   * Collect the entityIds of every STANDALONE HA entity device for a broker.
   * A standalone device is a top-level (`parentDeviceId === null`) HA device
   * whose source carries an `entityId` and NO `haDeviceId` (the Container path
   * carries `haDeviceId`; its accessory children carry a parent). Used to mark
   * `alreadyAdopted` on the `entities` granularity: a container-child for the
   * same entity does NOT count (both import paths coexist).
   */
  private async collectStandaloneAdoptedEntityIds(brokerId: string): Promise<Set<string>> {
    const all = await this.ctx.kernel.devices.getAll()
    const out = new Set<string>()
    for (const dev of all) {
      if (dev.parentDeviceId !== null) continue
      const source = readHaSource(this.snapshotConfig(dev))
      if (source === null) continue
      if (source.brokerId !== brokerId) continue
      if (source.haDeviceId !== undefined) continue
      if (source.entityId === undefined) continue
      out.add(source.entityId)
    }
    return out
  }

  /** Flatten a device's live config into a plain blob for `readHaSource`. */
  private snapshotConfig(device: IDevice): Record<string, unknown> {
    const blob: Record<string, unknown> = {}
    for (const entry of device.config.entries()) {
      blob[entry.key] = entry.value
    }
    return blob
  }

  /**
   * `entities` granularity candidate listing: a FLAT per-entity candidate list
   * (no `children`). Reuses the same live HA inventory as the device path; each
   * mapped entity becomes one standalone candidate. `alreadyAdopted` is true
   * only when a standalone device for that entity already exists.
   */
  private async listEntityCandidates(
    input: Pick<ListCandidatesInput, 'integrationId' | 'page' | 'pageSize' | 'filterText'>,
  ): Promise<ListCandidatesOutput> {
    const { integrationId, page, pageSize, filterText } = input
    const brokerId = this.requireRegistry().getBrokerIdByIntegrationId(integrationId)
    const adoptedEntityIds = await this.collectStandaloneAdoptedEntityIds(brokerId)
    const haDevices = await this.fetchHaDiscoveredDevices(brokerId)

    // Flat per-entity candidate list (skips unmapped entities + marks
    // standalone-adopted ones).
    let candidates = buildStandaloneEntityCandidates(haDevices, adoptedEntityIds)

    // Candidate-list text/query narrowing (distinct from the granularity filter).
    if (filterText?.search) {
      const q = filterText.search.toLowerCase()
      candidates = candidates.filter(
        (c) => c.name.toLowerCase().includes(q) || c.childNativeId.toLowerCase().includes(q),
      )
    }
    if (filterText?.adoptedOnly === true) {
      candidates = candidates.filter((c) => c.alreadyAdopted)
    }
    if (filterText?.unadoptedOnly === true) {
      candidates = candidates.filter((c) => !c.alreadyAdopted)
    }

    const totalCount = candidates.length
    const start = (page - 1) * pageSize
    return {
      candidates: candidates.slice(start, start + pageSize),
      totalCount,
      page,
      pageSize,
    }
  }

  /**
   * `entities` granularity adopt: import each `childNativeId` (= entityId) as a
   * STANDALONE top-level device (`parentDeviceId === null`), NOT a Container.
   *
   * Each device is created via `kernel.devices.create` with:
   *   - stableId `ha:<broker>:entity:<entityId>` (collision-free vs `:dev:`),
   *   - the `standaloneEntityDeviceClass` cap-re-derive dispatcher as the class
   *     (so the kernel's captured rebuild factory re-derives the concrete
   *     per-domain class via `pickHaChildClass(config.capabilities)` on every
   *     `applyDerivedSpec` — class drift rebuilds correctly), and
   *   - the entity-adoption-proof config blob (`readHaSource` recognises it).
   *
   * Standalone devices have no accessory children, so each result entry carries
   * `parentDeviceId = <newId>` (the device's own id) and `accessoryDeviceIds: []`.
   */
  private async adoptStandaloneEntities(
    input: Pick<
      AdoptInput,
      'integrationId' | 'childNativeIds' | 'filter' | 'perCandidate' | 'importLocations'
    >,
  ): Promise<AdoptResult> {
    const { integrationId, childNativeIds, perCandidate, importLocations } = input
    const brokerId = this.requireRegistry().getBrokerIdByIntegrationId(integrationId)
    const haDevices = await this.fetchHaDiscoveredDevices(brokerId)

    // Index every mapped entity across all devices by entityId for O(1) lookup.
    const entityById = new Map<string, HaDiscoveredEntity>()
    for (const dev of haDevices) {
      for (const ent of dev.entities) {
        if (ent.mappedTo === null) continue
        entityById.set(ent.entityId, ent)
      }
    }

    // Curated location registry, fetched ONCE per adopt call (only when
    // location import is requested), threaded through the loop for reuse.
    let knownLocations: readonly string[] =
      importLocations === true ? await this.ctx.api.deviceManager.listLocations.query() : []

    const adopted: AdoptedEntry[] = []
    let failures = 0

    for (const entityId of childNativeIds) {
      try {
        const entity = entityById.get(entityId)
        if (!entity || entity.mappedTo === null) {
          throw new Error(`entity '${entityId}' not found / not mappable on broker '${brokerId}'`)
        }
        const mapping = entity.mappedTo
        const pc = perCandidate?.[entityId]
        const config = buildStandaloneEntityConfig({
          entity,
          brokerId,
          ...(integrationId !== undefined ? { integrationId } : {}),
          ...(pc?.name !== undefined ? { name: pc.name } : {}),
        })
        const name = typeof config['name'] === 'string' ? config['name'] : entityId
        const role = typeof config['role'] === 'string' ? config['role'] : undefined
        const stableId = generateStandaloneEntityStableId(brokerId, entityId)

        const device = await this.ctx.kernel.devices.create(
          stableId,
          standaloneEntityDeviceClass,
          config,
          null,
          {
            type: mapping.deviceType,
            name,
            ...(integrationId !== undefined ? { integrationId } : {}),
            ...(role !== undefined ? { role } : {}),
          },
        )

        // Best-effort: assign the entity's imported source area as the
        // device's location. NEVER fails the adopt.
        if (importLocations === true && entity.area != null) {
          knownLocations = await this.assignImportedLocation(device.id, entity.area, knownLocations)
        }

        adopted.push({ childNativeId: entityId, parentDeviceId: device.id, accessoryDeviceIds: [] })
      } catch (err) {
        failures += 1
        this.ctx.logger.warn('ha-adoption: standalone entity adopt failed (skipped)', {
          tags: { integrationId },
          meta: { brokerId, entityId, error: errMsg(err) },
        })
      }
    }

    if (failures > 0 && adopted.length === 0) {
      throw new Error(
        `ha-adoption: all ${failures} standalone entity adopt(s) failed for integration '${integrationId}'`,
      )
    }
    return { adopted }
  }

  /**
   * Best-effort: resolve an imported source area to a CamStack location and
   * assign it to a freshly-adopted device. Reuses an existing CamStack location
   * via fuzzy match (`bestLocationMatch`), otherwise creates a new label.
   *
   * Takes the known-locations list and returns the possibly-extended list so
   * the caller can thread it across candidates in one adopt call (a label
   * created here is reused — never created twice in the same call).
   *
   * A location failure NEVER fails the adopt — any error is logged and the
   * unchanged known-locations list is returned.
   */
  private async assignImportedLocation(
    deviceId: number,
    externalLocation: string,
    knownLocations: readonly string[],
  ): Promise<readonly string[]> {
    try {
      const match = bestLocationMatch(externalLocation, knownLocations)
      const name = match ?? externalLocation
      let locations = knownLocations
      if (match === null) {
        await this.ctx.api.deviceManager.addLocation.mutate({ name })
        locations = [...knownLocations, name]
      }
      await this.ctx.api.deviceManager.setLocation.mutate({ deviceId, location: name })
      return locations
    } catch (err) {
      this.ctx.logger.warn('ha-adoption: location import failed (non-fatal)', {
        meta: { deviceId, externalLocation, error: errMsg(err) },
      })
      return knownLocations
    }
  }

  /**
   * Fetch live HA device + entity inventory for a single broker and map
   * it to the addon-internal `HaDiscoveredDevice[]` shape. Shared between
   * `discoverDevices` (device-provider) and the `device-adoption` handlers.
   *
   * Entities with `device_id === null` (helpers / template / daily stats) are
   * collected under a synthetic {@link HA_ORPHAN_ENTITIES_DEVICE_ID} bucket so
   * the Entities adoption tab + standalone reconcile can see them. Callers on
   * the Devices path must filter that bucket out.
   *
   * Unlike the old `HaDiscoveryService`, this is stateless — every call
   * goes to the live WS; caching is intentionally omitted to keep the
   * adoption path simple (the modal fetches once per session).
   */
  private async fetchHaDiscoveredDevices(brokerId: string): Promise<HaDiscoveredDevice[]> {
    const manager = this.requireRegistry().getManager(brokerId)
    if (!manager) throw new Error(`ha-broker '${brokerId}' not found`)

    const [rawDevices, rawEntities, rawAreas] = await Promise.all([
      manager.sendMessage<readonly Record<string, unknown>[]>({
        type: 'config/device_registry/list',
      }),
      manager.sendMessage<readonly Record<string, unknown>[]>({
        type: 'config/entity_registry/list',
      }),
      manager.sendMessage<readonly Record<string, unknown>[]>({
        type: 'config/area_registry/list',
      }),
    ])

    const stateSnapshot = manager.snapshotAllStates()

    // Build area id → name lookup.
    const areaById = new Map<string, string>()
    for (const raw of rawAreas) {
      const areaId = typeof raw['area_id'] === 'string' ? raw['area_id'] : null
      const name = typeof raw['name'] === 'string' ? raw['name'] : null
      if (areaId && name) areaById.set(areaId, name)
    }

    // Normalise and bucket entities by device id; skip disabled ones (they are
    // inert in HA — no state — so adopting them would surface dead children).
    // Rows with `device_id === null` (helpers / template / daily stats) go into
    // a synthetic orphan bucket so the Entities adoption tab can import them
    // as standalone devices — they never appear as Devices-tab candidates.
    const entitiesByDevice = new Map<string, (typeof rawEntities)[number][]>()
    const orphanRaws: (typeof rawEntities)[number][] = []
    for (const raw of rawEntities) {
      const entityId = typeof raw['entity_id'] === 'string' ? raw['entity_id'] : null
      const deviceId = typeof raw['device_id'] === 'string' ? raw['device_id'] : null
      const disabledBy =
        raw['disabled_by'] !== null && raw['disabled_by'] !== undefined
          ? String(raw['disabled_by'])
          : null
      if (!entityId || disabledBy !== null) continue
      if (!deviceId) {
        orphanRaws.push(raw)
        continue
      }
      const bucket = entitiesByDevice.get(deviceId)
      if (bucket) bucket.push(raw)
      else entitiesByDevice.set(deviceId, [raw])
    }

    const mapRawEntity = (
      raw: (typeof rawEntities)[number],
      deviceAreaName: string | null,
    ): HaDiscoveredEntity => {
      const entityId = raw['entity_id'] as string
      const domain = entityId.split('.')[0] ?? entityId
      const stateEntry = stateSnapshot[entityId] as HaEntityState | undefined
      const attributes = stateEntry?.attributes ?? {}
      // device_class precedence: entity-registry override → integration
      // default → live state attribute. Many integrations (energy plugs,
      // ESPHome, Zigbee) surface device_class ONLY in the state attributes,
      // not the entity registry; without the attribute fallback those
      // sensors map to enum-sensor and lose their unit/typed role.
      const deviceClass =
        typeof raw['device_class'] === 'string'
          ? raw['device_class']
          : typeof raw['original_device_class'] === 'string'
            ? raw['original_device_class']
            : typeof attributes['device_class'] === 'string'
              ? attributes['device_class']
              : null
      const unit =
        typeof attributes['unit_of_measurement'] === 'string'
          ? attributes['unit_of_measurement']
          : null
      const rawOptions = attributes['options']
      const options: string[] | null =
        Array.isArray(rawOptions) && rawOptions.length > 0
          ? (rawOptions as unknown[]).filter((x): x is string => typeof x === 'string')
          : null
      // Entity's OWN area (entity-registry `area_id`) wins; else inherit the
      // parent device's area. Either may be null → entity has no area.
      const entityAreaId = typeof raw['area_id'] === 'string' ? raw['area_id'] : null
      const entityArea = entityAreaId
        ? (areaById.get(entityAreaId) ?? deviceAreaName)
        : deviceAreaName
      // HA `entity_category` ('config' | 'diagnostic' | null) drives the
      // accordion section. Any other/unknown value collapses to null (control).
      const rawCategory = raw['entity_category']
      const entityCategory: HaEntityCategory | null =
        rawCategory === 'config' || rawCategory === 'diagnostic' ? rawCategory : null
      const mapping = mapHaEntityToCamStack({ domain, deviceClass, attributes })
      const friendlyName =
        typeof raw['name'] === 'string' && raw['name']
          ? raw['name']
          : typeof raw['original_name'] === 'string' && raw['original_name']
            ? raw['original_name']
            : ((typeof attributes['friendly_name'] === 'string'
                ? attributes['friendly_name']
                : null) ?? entityId)

      return {
        entityId,
        domain,
        name: friendlyName,
        state: stateEntry?.state ?? 'unknown',
        deviceClass,
        unitOfMeasurement: unit,
        area: entityArea,
        options,
        entityCategory,
        mappedTo: mapping
          ? {
              deviceType: mapping.deviceType,
              role: mapping.role,
              capabilities: [...mapping.capabilities],
              features: mapping.features ? [...mapping.features] : [],
              ...(mapping.dateTimeFormat !== undefined
                ? { dateTimeFormat: mapping.dateTimeFormat }
                : {}),
            }
          : null,
        alreadyAdopted: false,
        adoptedCamDeviceId: null,
      }
    }

    const out: HaDiscoveredDevice[] = []

    for (const rawDev of rawDevices) {
      const devId = typeof rawDev['id'] === 'string' ? rawDev['id'] : null
      if (!devId) continue
      const disabledBy =
        rawDev['disabled_by'] !== null && rawDev['disabled_by'] !== undefined
          ? String(rawDev['disabled_by'])
          : null
      if (disabledBy !== null) continue

      const areaIdRaw = typeof rawDev['area_id'] === 'string' ? rawDev['area_id'] : null
      // Parent device's resolved area name — also the per-entity fallback area
      // when an entity has no area of its own.
      const deviceAreaName = areaIdRaw ? (areaById.get(areaIdRaw) ?? null) : null
      const entBucket = entitiesByDevice.get(devId) ?? []

      const entities: HaDiscoveredEntity[] = entBucket.map((raw) =>
        mapRawEntity(raw, deviceAreaName),
      )

      const devName =
        typeof rawDev['name_by_user'] === 'string' && rawDev['name_by_user']
          ? rawDev['name_by_user']
          : typeof rawDev['name'] === 'string' && rawDev['name']
            ? rawDev['name']
            : entBucket[0]
              ? String(entBucket[0]['name'] ?? entBucket[0]['original_name'] ?? devId)
              : devId

      // Integration domain — the dominant REAL `entity_registry.platform`
      // across this device's entities (noise platforms excluded). Surfaced so
      // the adoption modal can fuzzy-search by integration (e.g. `dreame_vacuum`).
      const entityPlatforms = entBucket.map((raw) =>
        typeof raw['platform'] === 'string' ? raw['platform'] : null,
      )
      const integration = deriveIntegrationDomain(entityPlatforms)

      out.push({
        haDeviceId: devId,
        name: devName,
        area: deviceAreaName,
        manufacturer: typeof rawDev['manufacturer'] === 'string' ? rawDev['manufacturer'] : null,
        model: typeof rawDev['model'] === 'string' ? rawDev['model'] : null,
        swVersion: typeof rawDev['sw_version'] === 'string' ? rawDev['sw_version'] : null,
        integration,
        entityCount: entities.length,
        entities,
        alreadyAdopted: false,
        adoptedCamDeviceId: null,
      })
    }

    if (orphanRaws.length > 0) {
      const entities = orphanRaws.map((raw) => mapRawEntity(raw, null))
      const entityPlatforms = orphanRaws.map((raw) =>
        typeof raw['platform'] === 'string' ? raw['platform'] : null,
      )
      out.push({
        haDeviceId: HA_ORPHAN_ENTITIES_DEVICE_ID,
        name: 'Standalone entities',
        area: null,
        manufacturer: null,
        model: null,
        swVersion: null,
        integration: deriveIntegrationDomain(entityPlatforms),
        entityCount: entities.length,
        entities,
        alreadyAdopted: false,
        adoptedCamDeviceId: null,
      })
    }

    return out
  }

  /**
   * Re-align every adopted HA Container under a broker with the broker's
   * CURRENT mapping. Triggered on broker (re)connect (= HA restart), on a
   * periodic timer, and on demand. Reconciles each Container whose haDeviceId is
   * still present against the SHARED inventory snapshot (fetched once per tick by
   * {@link reconcileBroker}). Best-effort: a single container's failure never
   * aborts the sweep.
   */
  /**
   * After the kernel restores this provider's devices, reconcile any broker
   * that is already connected. Closes the bootstrap race: `onBrokerConnected`
   * fires during `onInitialize` (broker WS connect) BEFORE the kernel calls
   * `restoreDevices`, so at that point `getAll()` is empty. Once devices are in
   * the registry we re-sync here; `onBrokerConnected` still covers the reverse
   * order (broker connects after devices, e.g. a later HA restart).
   */
  override async restoreDevices(savedDevices: readonly SavedDevice[]): Promise<void> {
    await super.restoreDevices(savedDevices)
    void this.reconcileAllConnectedBrokers()
  }

  /**
   * HA restore is two-shaped. The default `BaseDeviceProvider.onRestoreDevices`
   * resolves a top-level row's class strictly from `deviceClasses[type]`, which
   * for HA only maps `Container → HaContainerDevice`. A STANDALONE entity device
   * (adopted via the `entities` granularity) persists with an ENTITY device-type
   * (Switch / Sensor / Light / …) that is NOT in that map — so the default pass
   * would skip it (warn + continue) and it would silently vanish on reboot.
   *
   * Partition the rows up front: standalone entity devices are re-instantiated
   * here via `kernel.devices.create(stableId, standaloneEntityDeviceClass, {})`
   * — the SAME create primitive (and thus the SAME captured cap-re-derive
   * rebuild factory) the `adopt('entities')` path uses, so a post-restore
   * `applyDerivedSpec` keeps re-deriving the concrete class via
   * `pickHaChildClass(config.capabilities)`. The dispatcher reads the persisted
   * config the kernel loads from disk (restore passes `config = {}`, the DB row
   * is canonical) to pick the per-domain class. Everything else (Container +
   * accessory children) is delegated to the default pass unchanged.
   */
  protected override async onRestoreDevices(savedDevices: readonly SavedDevice[]): Promise<void> {
    const { standalone, containerChildren, rest } = partitionRestoreDevices(savedDevices)

    // Restore via the dispatcher: `create` re-derives the concrete class from
    // the persisted config AND captures the rebuild factory keyed by the
    // dispatcher, so class drift rebuilds correctly post-restore. Under the
    // bounded restore retry (D347): a build refused on a runtime-state load
    // that did not answer (D677) is retried, not lost until a restart.
    await this.restoreWithBoundedRetry(standalone, async (saved) => {
      await this.ctx.kernel.devices.create(saved.stableId, standaloneEntityDeviceClass, {})
    })

    // Container accessory children are intentionally NOT restored here: their
    // parent `HaContainerDevice`'s `getAccessoryChildren()` + the kernel's
    // accessory-spawn rebuild them from the persisted `entities[]`. They are
    // partitioned out of `rest` so the default Pass 2 never sees them — most
    // importantly so an `EventEmitter` entity child is NOT mis-instantiated as
    // the Case-2 aggregator (`deviceClasses[EventEmitter] = HaEventBusDevice`),
    // whose `kind:'event-bus'` schema would reject the entity-child config.
    void containerChildren

    // Default two-pass restore for the Container parents + the top-level
    // event-bus aggregator. The standalone + container-child rows are excluded
    // so the default pass neither logs a spurious "no device class for type"
    // warning nor resolves an entity child to the wrong class.
    await super.onRestoreDevices(rest)
  }

  /** Re-sync every currently-connected broker's adopted devices (Containers +
   *  standalone entities). Driven by the periodic timer + the post-restore hook;
   *  skips disconnected brokers. */
  private async reconcileAllConnectedBrokers(): Promise<void> {
    if (!this.registry) return
    for (const { brokerId, manager } of this.registry.listManagers()) {
      if (manager.getInfo().status !== 'connected') continue
      await this.reconcileBroker(brokerId)
    }
  }

  /**
   * Reconcile ONE broker's adopted devices — both Containers AND standalone
   * entity devices — off a SINGLE shared HA inventory fetch (3 WS calls per tick,
   * not 6). Driven by the on-connect callback (HA restart), the periodic timer,
   * and the post-restore hook. Best-effort: a fetch failure or a per-reconciler
   * failure never propagates out, so a multi-broker sweep never aborts on one
   * broker.
   */
  private async reconcileBroker(brokerId: string): Promise<void> {
    // Ensure the per-broker generic bus-event aggregator exists (Case 2). Runs
    // on every reconcile (on-connect / periodic / post-restore) and is
    // idempotent on its stableId, so a connected broker always has a live
    // aggregator ready to receive routed bus events.
    try {
      await this.ensureEventBusDevice(brokerId)
    } catch (err) {
      this.ctx.logger.warn('ha bus-event aggregator ensure failed', {
        meta: { brokerId, error: errMsg(err) },
      })
    }
    await reconcileBroker(brokerId, {
      fetch: (id) => this.fetchHaDiscoveredDevices(id),
      reconcileContainers: (id, discovered) => this.reconcileBrokerContainers(id, discovered),
      reconcileStandalone: (id, discovered) =>
        this.reconcileBrokerStandaloneEntities(id, discovered),
      onFetchError: (id, error) => {
        this.ctx.logger.warn('ha re-sync: inventory fetch failed', {
          meta: { brokerId: id, error: errMsg(error) },
        })
      },
    })
  }

  /** Mark every HA device of `brokerId` offline when its WS drops (A2). Thin
   *  wrapper over the `markBrokerDevicesOffline` helper + a one-line summary log.
   *  `kernel.devices.getAll()` is already scoped to this addon's devices. */
  private async markBrokerDevicesOffline(brokerId: string): Promise<void> {
    const devices = await this.ctx.kernel.devices.getAll()
    const marked = markBrokerDevicesOffline(devices, brokerId)
    if (marked > 0) {
      this.ctx.logger.info('ha broker disconnected — marked devices offline', {
        meta: { brokerId, marked },
      })
    }
  }

  private async reconcileBrokerContainers(
    brokerId: string,
    haDevices: readonly HaDiscoveredDevice[],
  ): Promise<void> {
    const byHaDeviceId = new Map(haDevices.map((d) => [d.haDeviceId, d]))

    const all = await this.ctx.kernel.devices.getAll()
    for (const dev of all) {
      if (dev.parentDeviceId !== null) continue
      if (dev.config.get('system') !== 'homeassistant') continue
      if (dev.config.get('brokerId') !== brokerId) continue
      const haDeviceId = dev.config.get('haDeviceId')
      if (typeof haDeviceId !== 'string') continue
      const haDevice = byHaDeviceId.get(haDeviceId)
      if (!haDevice) continue // HA device gone — leave to explicit release/unadopt
      try {
        await this.reconcileContainer(dev, haDevice)
      } catch (err) {
        const integrationId = dev.config.get('integrationId')
        this.ctx.logger.warn('ha re-sync: container reconcile failed', {
          tags: {
            deviceId: dev.id,
            ...(typeof integrationId === 'string' ? { integrationId } : {}),
          },
          meta: { brokerId, haDeviceId, error: errMsg(err) },
        })
      }
    }
  }

  /**
   * Re-align every STANDALONE HA entity device under a broker with the broker's
   * CURRENT mapping — the `entities`-granularity sibling of
   * {@link reconcileBrokerContainers}. Driven by the SAME triggers (on-connect,
   * the periodic timer, post-restore) right after the Container reconcile. Live
   * STATE already flows via the per-entity `(brokerId, entityId)` broker
   * subscription; this handles only CAPABILITY/CLASS/role drift (e.g. an entity
   * gaining `brightness` → switch rebuilds into a light).
   *
   * Takes the SHARED HA inventory snapshot (fetched once per tick by
   * {@link reconcileBroker}), flattens it to a fresh entity map, plans the drift
   * via the pure {@link planStandaloneReconcile}, and rebuilds each drifted device
   * via the generic `applyDerivedSpec` (the captured cap-re-derive factory
   * re-derives the concrete class). An entity that vanished from HA is left in
   * place — standalone devices are operator-owned (no membership concept).
   * Best-effort: a single device's failure never aborts the sweep.
   */
  private async reconcileBrokerStandaloneEntities(
    brokerId: string,
    haDevices: readonly HaDiscoveredDevice[],
  ): Promise<void> {
    const freshById = new Map<string, HaDiscoveredEntity>()
    for (const dev of haDevices) {
      for (const ent of dev.entities) {
        if (ent.mappedTo === null) continue
        freshById.set(ent.entityId, ent)
      }
    }

    const all = await this.ctx.kernel.devices.getAll()
    const actions = planStandaloneReconcile(all, freshById, brokerId)
    for (const action of actions) {
      try {
        await this.ctx.kernel.devices.applyDerivedSpec(action.deviceId, {
          ...(action.type !== undefined ? { type: action.type } : {}),
          ...(action.role !== undefined ? { role: action.role } : {}),
          ...(action.config !== undefined ? { config: action.config } : {}),
        })
        this.ctx.logger.info('ha re-sync: standalone entity reconciled', {
          tags: { deviceId: action.deviceId },
          meta: { brokerId },
        })
      } catch (err) {
        this.ctx.logger.warn('ha re-sync: standalone entity reconcile failed', {
          tags: { deviceId: action.deviceId },
          meta: { brokerId, error: errMsg(err) },
        })
      }
    }
  }

  /**
   * Reconcile one Container against a freshly-fetched HA device. Persists the
   * new `entities[]` (durable across restart + feeds `getAccessoryChildren`),
   * rebuilds each existing child whose mapping-derived shape changed via the
   * generic `applyDerivedSpec` primitive (preserving operator name/area), and
   * reprobes when entities were added/removed so children spawn/orphan-purge.
   */
  private async reconcileContainer(
    container: IDevice,
    haDevice: HaDiscoveredDevice,
  ): Promise<{ changed: boolean; rebuiltChildren: number }> {
    const persisted: HaContainerEntityConfig[] = parseContainerEntities(
      container.config.get('entities'),
    )
    const fresh = buildContainerEntities(haDevice)
    const plan = diffContainerEntities(persisted, fresh)
    if (!plan.entitiesChanged) return { changed: false, rebuiltChildren: 0 }

    await container.config.setAll({ entities: plan.freshEntities })

    if (plan.changedChildren.length > 0) {
      const children = await this.ctx.kernel.devices.getChildren(container.id)
      const childIdByEntityId = new Map<string, number>()
      const prefix = `${container.stableId}-`
      for (const child of children) {
        if (child.stableId.startsWith(prefix)) {
          childIdByEntityId.set(child.stableId.slice(prefix.length), child.id)
        }
      }
      for (const change of plan.changedChildren) {
        const childId = childIdByEntityId.get(change.entityId)
        if (childId === undefined) continue // not spawned yet — reprobe handles it
        await this.ctx.kernel.devices.applyDerivedSpec(childId, {
          type: change.type,
          ...(change.role !== undefined ? { role: change.role } : {}),
          config: change.config,
        })
      }
    }

    if (plan.membershipChanged && container instanceof HaContainerDevice) {
      await container.reprobe()
    }

    // Re-derive + persist the accordion layout from the freshly-persisted
    // entities so an entity_category change in HA re-sections automatically.
    // The battery cap follows the entities on the NEXT construction: a re-sync
    // that adds, swaps (binary↔numeric) or removes the battery entity rewrites
    // the container's config, and `applyDerivedSpec` rebuilds the instance, so
    // the constructor re-decides whether to register `battery` at all. Nothing
    // to re-author here since the derivation came in-provider (2026-08-08).
    if (container instanceof HaContainerDevice) {
      await container.persistChildLayout()
    }

    const integrationId = container.config.get('integrationId')
    this.ctx.logger.info('ha re-sync: container reconciled', {
      tags: {
        deviceId: container.id,
        ...(typeof integrationId === 'string' ? { integrationId } : {}),
      },
      meta: {
        haDeviceId: haDevice.haDeviceId,
        rebuiltChildren: plan.changedChildren.length,
        membershipChanged: plan.membershipChanged,
      },
    })
    return { changed: true, rebuiltChildren: plan.changedChildren.length }
  }

  /**
   * Ensure the per-broker generic bus-event aggregator device exists (Case 2).
   * Idempotent on the stableId `ha:<brokerId>:events`: returns the cached
   * deviceId when already created, else looks up an existing device with that
   * stableId (restore path), else creates a fresh `EventEmitter` device via
   * `kernel.devices.create`. Caches the resolved id for {@link routeBusEvent}.
   *
   * Race-tolerant: if `create` throws an "already registered" / duplicate-stableId
   * error — because Pass-1 restore beat this call — the error is caught, the
   * existing device is resolved via a `getAll()` lookup by stableId, cached, and
   * returned. Both orderings (ensure-first or restore-first) converge on the
   * single persisted device with NO warning.
   */
  private async ensureEventBusDevice(brokerId: string): Promise<number> {
    const cached = this.eventBusDeviceIds.get(brokerId)
    if (cached !== undefined) return cached

    const stableId = `ha:${brokerId}:events`

    // Fast-path: the device was persisted on a previous run and already
    // re-instantiated by the default restore pass (deviceClasses[EventEmitter]).
    const priorAll = await this.ctx.kernel.devices.getAll()
    const existing = priorAll.find((d) => d.stableId === stableId)
    if (existing) {
      this.eventBusDeviceIds.set(brokerId, existing.id)
      return existing.id
    }

    try {
      const device = await this.ctx.kernel.devices.create(
        stableId,
        HaEventBusDevice,
        { system: 'homeassistant', brokerId, kind: 'event-bus' },
        null,
        { type: DeviceType.EventEmitter, name: 'Home Assistant Events' },
      )
      this.eventBusDeviceIds.set(brokerId, device.id)
      return device.id
    } catch (createErr) {
      // Tolerate a duplicate-stableId collision: Pass-1 restore may have
      // registered the device between our `getAll()` check and `create`.
      // Detect by message substring — no cast needed.
      const msg = createErr instanceof Error ? createErr.message : String(createErr)
      if (!msg.includes('already registered')) throw createErr

      // Resolve the now-existing device by stableId and cache it.
      const afterAll = await this.ctx.kernel.devices.getAll()
      const restored = afterAll.find((d) => d.stableId === stableId)
      if (!restored) {
        // Should never happen: kernel said "already registered" but can't find it.
        throw createErr
      }
      this.eventBusDeviceIds.set(brokerId, restored.id)
      return restored.id
    }
  }

  /**
   * Route a curated HA bus event onto the broker's generic aggregator device.
   * Resolves the live `HaEventBusDevice` instance via the device registry (by
   * the cached deviceId) and calls `handleBusEvent`. When the cache misses,
   * delegates to {@link ensureEventBusDevice} so the aggregator is lazily
   * created (or found via a stableId lookup when Pass-1 restore already
   * registered it). Best-effort: events that arrive before the registry is
   * ready are dropped with a debug log.
   */
  private async routeBusEvent(brokerId: string, ev: HaBusEventEnvelope): Promise<void> {
    let deviceId = this.eventBusDeviceIds.get(brokerId)
    if (deviceId === undefined) {
      // Cache miss — lazily ensure/find the aggregator (idempotent, race-tolerant).
      try {
        deviceId = await this.ensureEventBusDevice(brokerId)
      } catch (err) {
        this.ctx.logger.debug('ha bus-event dropped — aggregator not ready', {
          meta: { brokerId, eventType: ev.eventType, error: errMsg(err) },
        })
        return
      }
    }
    const device = this.ctx.kernel.deviceRegistry?.getById(deviceId) ?? null
    if (!(device instanceof HaEventBusDevice)) {
      this.ctx.logger.debug('ha bus-event dropped — aggregator instance not resolvable', {
        meta: { brokerId, deviceId, eventType: ev.eventType },
      })
      return
    }
    device.handleBusEvent(ev)
  }

  private requireRegistry(): HaBrokerRegistry {
    if (!this.registry) throw new Error('ha provider not initialised')
    return this.registry
  }
}

function coerceHaTarget(target: Record<string, unknown>): PublishTargetHa {
  const domain = target['domain']
  const service = target['service']
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new Error('broker.publish: target.domain is required (HA call_service)')
  }
  if (typeof service !== 'string' || service.length === 0) {
    throw new Error('broker.publish: target.service is required (HA call_service)')
  }
  const out: {
    domain: string
    service: string
    entityId?: string
    areaId?: string
    deviceId?: string
  } = {
    domain,
    service,
  }
  const entityId = target['entityId']
  if (typeof entityId === 'string') out.entityId = entityId
  const areaId = target['areaId']
  if (typeof areaId === 'string') out.areaId = areaId
  const deviceId = target['deviceId']
  if (typeof deviceId === 'string') out.deviceId = deviceId
  return out
}

function coerceHaFilter(filter: Record<string, unknown>): SubscribeFilterHa {
  const entityIds = filter['entityIds']
  const domain = filter['domain']
  const out: { entityIds?: readonly string[]; domain?: string } = {}
  if (Array.isArray(entityIds)) {
    out.entityIds = entityIds.filter((v): v is string => typeof v === 'string')
  }
  if (typeof domain === 'string') {
    out.domain = domain
  }
  return out
}
