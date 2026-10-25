import {
  BaseDeviceProvider,
  bestLocationMatch,
  brokerCapability,
  deviceAdoptionCapability,
  DeviceType,
  errMsg,
  EventCategory,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type IBrokerProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type ProviderRegistration,
  type SavedDevice,
  type SystemEvent,
} from '@camstack/types'
import { migrateLegacyConfig, type HmBrokerEntry, type HomematicAddonConfigV2 } from './config.js'
import { hmBrokersEntryKind } from './broker-record-kinds.js'
import { HmBrokerStore } from './hm-broker-store.js'
import { HmBrokerRegistry, sameConnection } from './homematic-broker-registry.js'
import { buildHmBrokerProvider } from './homematic-broker-provider.js'
import { buildHmAdoptionProvider } from './homematic-adoption-provider.js'
import { cascadeRemoveDevicesForBroker } from './homematic-broker-device-cascade.js'
import { computeBrokerCleanup, linkBrokersToIntegrations } from './homematic-reconciler.js'
import { HmContainerDevice } from './devices/hm-container-device.js'
import { hmChildDeviceClass } from './devices/hm-child-class-factory.js'
import { isStandaloneEntitySaved } from './devices/hm-standalone-entity.js'
import { setBrokerDevicesOnline, type OfflineTarget } from './homematic-broker-offline.js'

/** Default multi-broker config — a fresh install starts with no CCUs. */
const DEFAULTS: HomematicAddonConfigV2 = { brokers: [] }

/**
 * Homematic device-provider addon (multi-CCU).
 *
 * On init it migrates any legacy single-CCU config into the multi-broker
 * shape, constructs the {@link HmBrokerRegistry} (one live `nodehomematic`
 * facade per registered CCU), and restores every persisted broker. It
 * registers the generic `broker` cap provider (so the External-systems UI
 * can add / edit / remove CCUs) and the `device-adoption` cap provider (so
 * the operator picks which enumerated CCU devices to adopt).
 *
 * Phase 2: devices come ONLY from explicit adoption (+ `restoreDevices`
 * for already-adopted ones) — there is no blanket auto-create of every
 * enumerated CCU device. Adopted devices are keyed on a broker-scoped
 * stable id (`hm:${brokerId}:${address}`) so reconnects + reboots reuse
 * the existing rows.
 */
export class HomematicProviderAddon extends BaseDeviceProvider<HomematicAddonConfigV2> {
  protected readonly addonId = 'provider-homematic'
  protected readonly providerName = 'Homematic'
  // Container is the parent class for the accessory-children model: it
  // declares `getAccessoryChildren()` so the kernel auto-spawns + reconciles
  // one child per functional entity (actuator / sensor / event-emitter /
  // diagnostic / firmware-update). Accessory children are NOT mapped here —
  // their types (Switch / Cover / Sensor / EventEmitter / Update / …) fall
  // through the default `onRestoreDevices` Pass 2 as "accessory, skip" and the
  // parent Container's `getAccessoryChildren()` rebuilds them on restore
  // (mirrors `HaContainerDevice`).
  //
  // The legacy flat `HomematicDevice` entries are REMOVED: adoption now always
  // creates a Container parent, so no flat top-level device is ever created.
  // No flat Homematic device is persisted on the hub (devices come only from
  // adoption + restore), so removing them orphans nothing. `HomematicDevice`
  // remains exported from `index.ts` and reused by the child-device decoding
  // helpers; only the parent-class registration is dropped.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: HmContainerDevice,
  }

  /** Live multi-broker registry, or null before init / after shutdown. */
  private registry: HmBrokerRegistry | null = null
  private brokerStore: HmBrokerStore | null = null
  private activeBrokers: readonly HmBrokerEntry[] = []

  constructor() {
    super({ ...DEFAULTS })
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    // ── Migrate the persisted config BEFORE building the registry ────────
    //
    // CRITICAL: `this.config` is the resolved runtime config and only ever
    // carries keys present in `DEFAULTS` (BaseAddon.resolveConfig copies
    // ONLY default keys, by name + matching type). DEFAULTS has no
    // `connection` key, so the legacy single-CCU `{ connection: {...} }`
    // blob is NOT visible on `this.config`. We therefore read the RAW
    // persisted store and migrate THAT, so the live CCU is preserved across
    // the config-shape change.
    const rawStore = await this.resolveGlobalStore()
    const migrated = migrateLegacyConfig(rawStore)
    if (this.brokersDiffer(migrated.brokers, this.config.brokers)) {
      await this.updateGlobalSettings({ brokers: migrated.brokers })
    }

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('provider-homematic: ctx.records is required (hub-only addon)')
    }
    await records.declare({ brokers: hmBrokersEntryKind })
    this.brokerStore = HmBrokerStore.of(records)
    this.activeBrokers = await this.loadPersistedBrokers()

    // ── Registry + lifecycle hooks ───────────────────────────────────────
    this.registry = new HmBrokerRegistry(this.ctx.logger)
    // Phase 2: devices come ONLY from explicit adoption (+ restoreDevices for
    // already-adopted ones), NOT from a blanket auto-create of every CCU
    // device. The connect hook now only logs; the operator picks which
    // enumerated devices to adopt via the `device-adoption` cap.
    this.registry.setOnBrokerConnected((brokerId) => {
      this.ctx.logger.info('Homematic: broker connected', { meta: { brokerId } })
      this.setBrokerDevicesOnline(brokerId, true)
      // Containers that restored while the CCU was unreachable left
      // `lastProbedAt === 0` (see HmContainerDevice.onProbe). Reprobe now that
      // the facade is populated so accessory children spawn/reconcile.
      void this.reprobeBrokerContainers(brokerId)
    })
    this.registry.setOnBrokerDisconnected((brokerId) => {
      this.setBrokerDevicesOnline(brokerId, false)
    })

    // `restore` awaits each manager's `facade.start()`, so facades are up
    // (and discoverable for adoption) once init completes.
    await this.registry.restore(this.activeBrokers)

    this.ctx.logger.info('Homematic: provider initialised', {
      meta: { brokerCount: this.activeBrokers.length },
    })

    // Sync integration records → broker entries (Approach A): link surviving
    // integrations to their referenced brokers + cascade-clean brokers (and
    // their adopted devices) whose spawning integration was deleted. Re-runs
    // on every integration lifecycle event.
    await this.reconcileIntegrationsToBrokers()
    this.subscribeIntegrationLifecycle()

    return [
      ...regs,
      { capability: brokerCapability, provider: this.buildBrokerProvider() },
      { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
    ]
  }

  /**
   * Reconcile the live registry against the persisted `brokers` array after
   * every settings write (UI save or `broker.*` cap). Mirrors the HA addon:
   * remove managers whose row vanished, start managers for new rows
   * (persisting the registry-allocated id back when it differs), and apply
   * connection updates to existing rows.
   */
  private async loadPersistedBrokers(): Promise<readonly HmBrokerEntry[]> {
    const store = this.brokerStore
    if (store !== null) {
      const fromRecords = await store.listResolved()
      if (fromRecords.length > 0) return fromRecords
    }
    return this.config.brokers
  }

  private async persistBrokerEntries(entries: readonly HmBrokerEntry[]): Promise<void> {
    this.activeBrokers = [...entries]
    const store = this.brokerStore
    if (store !== null) {
      await store.replaceAll(entries)
      return
    }
    await this.updateGlobalSettings({ brokers: [...entries] })
  }

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
          this.ctx.logger.warn('Homematic onConfigChanged: removeEntry failed', {
            meta: { brokerId: liveId, error: errMsg(err) },
          })
        }
      }
    }

    // Start managers for new rows + apply connection updates to existing ones.
    for (const entry of persisted) {
      if (entry.id && liveIds.has(entry.id)) {
        // Only reconnect the facade when the CONNECTION actually changed.
        // An `onConfigChanged` pass triggered solely by re-stamping the
        // `integrationId` FK (reconcileIntegrationsToBrokers) leaves the
        // connection identical — calling updateEntry there would needlessly
        // stop+start the facade (a ~10-20s reconnect on a 50-device CCU).
        if (sameConnection(entry.connection, reg.getConnection(entry.id))) {
          continue
        }
        try {
          await reg.updateEntry(entry.id, entry.connection)
        } catch (err) {
          this.ctx.logger.warn('Homematic onConfigChanged: updateEntry failed', {
            meta: { brokerId: entry.id, error: errMsg(err) },
          })
        }
        continue
      }
      // New row — `createEntry` allocates a fresh id; heal the persistence
      // row id when it differs (a UI-emitted row may arrive with empty id).
      try {
        const created = await reg.createEntry(entry.name, entry.connection)
        if (created.id !== entry.id) {
          const next = persisted.map((b) => (b === entry ? { ...b, id: created.id } : b))
          await this.persistBrokerEntries(next)
        }
      } catch (err) {
        this.ctx.logger.warn('Homematic onConfigChanged: failed to start new broker', {
          meta: { brokerName: entry.name, error: errMsg(err) },
        })
      }
    }
  }

  protected override async onShutdown(): Promise<void> {
    // Shut down the registry (stops every facade + clears the resolver)
    // before the BaseDeviceProvider teardown decommissions devices.
    try {
      await this.registry?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Homematic: provider shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.registry = null
    await super.onShutdown()
  }

  /**
   * Derive a stable id, broker-scoped so two CCUs exposing the same device
   * address don't collide on one id (mirrors the HA addon's
   * `ha:${brokerId}:dev:${haDeviceId}`). No Homematic devices exist on the
   * hub yet, so the scoping change orphans nothing.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const brokerId = String(config?.['brokerId'] ?? 'unknown')
    // Standalone ENTITY devices (the `entities` granularity) carry an
    // `hmEntityKey` marker and use a distinct `:entity:` infix so they never
    // collide with the Container's `hm:<broker>:<address>` scheme (an entity
    // key like `act-<chan>` is disjoint from a bare device address anyway).
    const entityKey = config?.['hmEntityKey']
    if (typeof entityKey === 'string' && entityKey.length > 0) {
      const hmAddress = String(config?.['hmAddress'] ?? config?.['address'] ?? 'unknown')
      return `hm:${brokerId}:entity:${hmAddress}#${entityKey}`
    }
    const address = String(config?.['address'] ?? config?.['hmAddress'] ?? Date.now())
    return `hm:${brokerId}:${address}`
  }

  // ── restore ────────────────────────────────────────────────────────────

  /**
   * Homematic restore is two-shaped (mirrors the HA addon).
   *
   * The default `BaseDeviceProvider.onRestoreDevices` resolves a top-level row's
   * class strictly from `deviceClasses[type]`, which for Homematic only maps
   * `Container → HmContainerDevice`. A STANDALONE entity device (adopted via the
   * `entities` granularity) persists with an ENTITY device-type (Switch /
   * Sensor / EventEmitter / Update / …) NOT in that map — so the default pass
   * would skip it (warn + continue) and it would silently vanish on reboot.
   *
   * Partition the rows: standalone entity devices are re-instantiated here via
   * `kernel.devices.create(stableId, hmChildDeviceClass, {})` — the SAME create
   * primitive (and captured cap-re-derive rebuild factory) the `adopt('entities')`
   * path uses, so the dispatcher re-derives the concrete child class from the
   * persisted `config.capabilities`. Everything else (Container parents +
   * accessory children) is delegated to the default pass unchanged: container
   * accessory children carry a `parentDeviceId` and an entity device-type not in
   * `deviceClasses`, so the default Pass 2 cleanly skips them and the parent
   * Container's `getAccessoryChildren()` rebuilds them.
   */
  protected override async onRestoreDevices(savedDevices: readonly SavedDevice[]): Promise<void> {
    const standalone: SavedDevice[] = []
    const rest: SavedDevice[] = []
    for (const saved of savedDevices) {
      if (isStandaloneEntitySaved(saved)) standalone.push(saved)
      else rest.push(saved)
    }

    // Under the bounded restore retry (D347): a build refused on a
    // runtime-state load that did not answer (D677) is retried, not lost
    // until a restart.
    await this.restoreWithBoundedRetry(standalone, async (saved) => {
      await this.ctx.kernel.devices.create(saved.stableId, hmChildDeviceClass, {})
    })

    await super.onRestoreDevices(rest)
  }

  // ── broker cap provider ────────────────────────────────────────────────

  private buildBrokerProvider(): IBrokerProvider {
    return buildHmBrokerProvider({
      ownerAddonId: this.ctx.id,
      registry: this.requireRegistry(),
      getBrokers: () => this.activeBrokers,
      persistBrokers: (brokers) => this.persistBrokerEntries([...brokers]),
      cascadeRemoveDevices: (brokerId) => this.cascadeRemoveDevicesForBroker(brokerId),
      logger: this.ctx.logger,
    })
  }

  /**
   * Remove every adopted device sourced from `brokerId`. Thin wrapper over
   * the shared cascade helper; guards a null kernel like the HA addon.
   */
  private async cascadeRemoveDevicesForBroker(brokerId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    await cascadeRemoveDevicesForBroker({
      reg,
      devices,
      addonId: this.addonId,
      brokerId,
      logger: this.ctx.logger,
    })
  }

  // ── integration → broker reconcile (Approach A) ────────────────────────

  /**
   * Mirror integration records → broker entries (Approach A).
   *
   * Under Approach A an integration record carries ONLY a `{ brokerId }` link
   * to a row in the addon's `config.brokers[]`. Brokers are created out-of-band
   * via the `broker.add` cap (the wizard UI), NOT by this reconciler cramming
   * credentials into the integration. So this pass does exactly three things:
   *
   *   - **Link**: for each surviving integration whose settings carry a
   *     `{ brokerId }` pointing at a live broker, record the
   *     `integrationId → brokerId` link in the registry so the generic
   *     `device-adoption` cap can resolve the broker.
   *   - **Persist FK**: stamp `integrationId` onto each linked broker so the
   *     cleanup-on-delete pass can collect orphans on a later run.
   *   - **Cleanup**: drop any broker spawned by an integration (carries an
   *     `integrationId` FK) once no surviving integration references it, AND
   *     cascade-remove its adopted devices. Manually-created brokers (no FK)
   *     are never auto-removed.
   *
   * Idempotent — runs on boot + on every integration.* event. The whole body
   * is guarded: if the integrations API is unavailable (or any call throws),
   * it warns and returns without throwing — `onInitialize` must not fail.
   */
  private async reconcileIntegrationsToBrokers(): Promise<void> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id)
      const survivingIntegrationIds = new Set(mine.map((i) => i.id))

      // ── Link: tag each integration's referenced broker ─────────────
      const integrations: { id: string; brokerId: string | undefined }[] = []
      for (const integration of mine) {
        const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
        const brokerId = typeof settings['brokerId'] === 'string' ? settings['brokerId'] : undefined
        integrations.push({ id: integration.id, brokerId })
        if (brokerId === undefined) continue
        if (!this.activeBrokers.some((b) => b.id === brokerId)) {
          this.ctx.logger.warn('Homematic integration→broker: linked broker not found', {
            meta: { integrationId: integration.id, brokerId },
          })
          continue
        }
        this.requireRegistry().linkIntegration(integration.id, brokerId)
      }

      // ── Persist FK: stamp integrationId onto each linked broker so the
      //    cleanup pass (below + future runs) can collect orphans. Wizard-
      //    created brokers start with no FK; without this they would leak
      //    forever.
      const linked = linkBrokersToIntegrations(this.activeBrokers, integrations)
      if (linked.some((b, i) => b !== this.activeBrokers[i])) {
        await this.persistBrokerEntries(linked)
      }

      // ── Cleanup: drop brokers whose spawning integration is gone, and
      //    cascade-remove their adopted devices. Reads this.activeBrokers
      //    (now FK-stamped). A broker just linked above belongs to a surviving
      //    integration, so it is never cleaned in the same pass.
      const toRemove = computeBrokerCleanup(this.activeBrokers, survivingIntegrationIds)
      if (toRemove.length === 0) return

      for (const id of toRemove) {
        try {
          await this.requireRegistry().removeEntry(id)
          await this.cascadeRemoveDevicesForBroker(id)
        } catch (err) {
          this.ctx.logger.warn('Homematic integration→broker: broker cleanup failed', {
            meta: { brokerId: id, error: errMsg(err) },
          })
        }
      }
      const nextBrokers = this.activeBrokers.filter((b) => !toRemove.includes(b.id))
      await this.persistBrokerEntries(nextBrokers)
      this.ctx.logger.info('Homematic integration→broker reconcile', {
        meta: {
          brokerCount: nextBrokers.length,
          integrationCount: mine.length,
          removed: toRemove.length,
        },
      })
    } catch (err) {
      this.ctx.logger.warn('Homematic integration→broker reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Subscribe to integration lifecycle events (enabled / disabled / deleted)
   * and re-run the integration→broker reconcile on each. The handler filters
   * to this addon's own integrations when the payload carries an `addonId`;
   * a payload without one falls through to an unconditional reconcile (the
   * full sync is idempotent, so a stray event is harmless).
   */
  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      // Fire-and-forget — reconcile runs the full sync; transient races
      // resolve on the next event.
      void this.reconcileIntegrationsToBrokers()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  /**
   * Build the `device-adoption` cap provider (Phase 2). The operator picks
   * which enumerated CCU devices to adopt; nothing is auto-created.
   *
   * All side-effecting deps are wired here so the pure builder stays
   * unit-testable. The integration→broker link is resolved ON DEMAND from
   * the integration's settings blob (`{ brokerId }`), mirroring the HA
   * addon. `adoptDevice` creates a {@link DeviceType.Container} parent (via
   * {@link HmContainerDevice}) whose `getAccessoryChildren()` auto-spawns one
   * accessory child per functional entity, then FETCHES those spawned children
   * (mirroring the HA addon's `kernel.devices.getChildren`) to return their
   * real ids. It stamps `{ system: 'homematic', brokerId, hmAddress, address,
   * integrationId }` onto the config so the cascade-remove + adopted-state
   * overlay resolve, and stamps `integrationId` into meta so the core
   * `removeByIntegration` cascade fires on integration delete.
   */
  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildHmAdoptionProvider({
      registry: this.requireRegistry(),
      logger: this.ctx.logger,
      getBrokerIdForIntegration: async (id) => {
        const settings = await this.ctx.api.integrations.getSettings.query({ id })
        const brokerId = settings['brokerId']
        if (typeof brokerId !== 'string') {
          throw new Error(`integration ${id} has no linked brokerId`)
        }
        return brokerId
      },
      listAdoptedHomematic: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (!reg || !devices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          // Only top-level (parent) devices — children, if any, cascade.
          if (d.parentDeviceId !== null) continue
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptDevice: async ({ hmAddress, brokerId, integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) {
          throw new Error('homematic adopt: kernel.devices unavailable')
        }
        // Adoption ALWAYS creates a Container parent — the inferred `type`
        // (passed for the candidate icon only) is intentionally ignored for
        // the created device. The Container's `getAccessoryChildren()` derives
        // the functional entities (actuator / sensor / event / diagnostic /
        // update) live from the facade. Stamp both `address` (read by
        // HmContainerDevice) and `hmAddress` (the alreadyAdopted scan +
        // cascade key) plus `system`/`brokerId`/`integrationId` provenance.
        const config = {
          address: hmAddress,
          hmAddress,
          brokerId,
          system: 'homematic',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(DeviceType.Container, config)
        // Stamp integrationId in META so core removeByIntegration cascades on
        // integration delete (config copy stays for our own reconcile + offline
        // filter). The container parent type is fixed.
        const device = await devices.create(stableId, HmContainerDevice, config, null, {
          type: DeviceType.Container,
          name,
          integrationId,
        })
        // Fetch the children that getAccessoryChildren() auto-spawned, mirroring
        // the HA addon's `kernel.devices.getChildren(parentId)`.
        const children = await devices.getChildren(device.id)
        return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
      },
      adoptStandaloneEntity: async ({ deviceType, role, name, integrationId, config }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) {
          throw new Error('homematic adopt entity: kernel.devices unavailable')
        }
        // Standalone-entity stableId carries the `hmEntityKey` marker, so
        // generateStableId mints the collision-free `hm:<broker>:entity:<addr>#<key>`
        // scheme. The class is the cap-re-derive dispatcher (`hmChildDeviceClass`),
        // which reads `config.capabilities` to pick the concrete child class on
        // create + on every captured rebuild. Stamp integrationId in META so the
        // core removeByIntegration cascade fires on integration delete.
        const stableId = this.generateStableId(deviceType, config)
        const meta = {
          type: deviceType,
          name,
          integrationId,
          ...(role !== null ? { role } : {}),
        }
        const device = await devices.create(stableId, hmChildDeviceClass, config, null, meta)
        return { deviceId: device.id }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
      listLocations: async () => this.ctx.api.deviceManager.listLocations.query(),
      assignLocation: async (deviceId, externalLocation, knownLocations) =>
        this.assignImportedLocation(deviceId, externalLocation, knownLocations),
    })
  }

  /**
   * Best-effort: resolve an imported CCU room to a CamStack location and assign
   * it to a freshly-adopted device. Reuses an existing CamStack location via
   * fuzzy match (`bestLocationMatch`), otherwise creates a new label.
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
      this.ctx.logger.warn('homematic adopt: location import failed (non-fatal)', {
        meta: { deviceId, externalLocation, error: errMsg(err) },
      })
      return knownLocations
    }
  }

  // ── Settings UI (External systems → integration settings panel) ────
  //
  // Approach A: an integration record carries ONLY a `{ brokerId }` link; it
  // never stores credentials. Brokers are created/edited via the `broker.*`
  // cap from the wizard (External systems → Brokers), NOT by cramming a
  // creation form into the integration settings. So this schema is purely
  // informational — there are no editable fields.

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'hm-broker',
          title: 'Homematic broker',
          titleKey: 'provider-homematic:globalSettings.s_hm-broker.title',
          columns: 1,
          fields: [
            {
              type: 'info' as const,
              key: 'brokerHelp',
              label: 'Brokers are managed separately',
              labelKey: 'provider-homematic:globalSettings.s_hm-broker.brokerHelp.label',
              content:
                'This integration links to a Homematic CCU broker managed under External systems → Brokers.',
            },
          ],
        },
      ],
    })
  }

  // ── Manual creation ─────────────────────────────────────────────────────
  //
  // SCAFFOLD: manual single-device creation is not supported — Homematic
  // devices come from explicit adoption via the `device-adoption` cap
  // (the operator picks which enumerated CCU devices to adopt). The CCU
  // connection form is served via the broker cap (`getSettingsSchema`).

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    // Phase 1: devices are adopted from the CCU enumeration, not created
    // manually. Phase 2 may add a minimal adoption path here.
    throw new Error('Homematic devices are adopted from the CCU, not created manually')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Set every adopted Homematic device for `brokerId` to the requested online
   * state. Delegates to {@link setBrokerDevicesOnline} and logs a summary when
   * any devices are actually transitioned. No-ops when `deviceRegistry` is not
   * yet available (e.g. during early init before the kernel is fully wired).
   */
  private setBrokerDevicesOnline(brokerId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setBrokerDevicesOnline(devices, brokerId, online)
    if (n > 0) {
      this.ctx.logger.info('Homematic: broker devices ' + (online ? 'online' : 'offline'), {
        meta: { brokerId, count: n },
      })
    }
  }

  /**
   * Reprobe every adopted {@link HmContainerDevice} for `brokerId` so the
   * kernel re-runs accessory reconcile against the live facade. Best-effort:
   * one container's failure must not block the rest (same discipline as HA's
   * post-connect reconcile).
   */
  private async reprobeBrokerContainers(brokerId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const containers = reg
      .getAllForAddon(this.addonId)
      .filter(
        (d): d is HmContainerDevice =>
          d instanceof HmContainerDevice && d.config.get('brokerId') === brokerId,
      )
    for (const container of containers) {
      try {
        await container.reprobe()
      } catch (err: unknown) {
        this.ctx.logger.warn('Homematic: container reprobe failed', {
          tags: { deviceId: container.id },
          meta: { brokerId, error: errMsg(err) },
        })
      }
    }
  }

  /** Return the live registry or throw if the addon is not initialised. */
  private requireRegistry(): HmBrokerRegistry {
    if (!this.registry) throw new Error('Homematic provider not initialised')
    return this.registry
  }

  /** True when the two broker lists differ by id-set or connection host. */
  private brokersDiffer(a: readonly HmBrokerEntry[], b: readonly HmBrokerEntry[]): boolean {
    if (a.length !== b.length) return true
    const byId = new Map(b.map((e) => [e.id, e]))
    for (const entry of a) {
      const other = byId.get(entry.id)
      if (!other) return true
      if (other.connection.host !== entry.connection.host) return true
    }
    return false
  }
}
