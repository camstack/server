import { z } from 'zod'
import { errMsg, type IEventBus, type IScopedLogger } from '@camstack/types'
import {
  HaIntegrationManager,
  type HaBrokerInfo,
  type HaBusEventEnvelope,
  type PublishTargetHa,
  type SubscribeFilterHa,
} from './ha-integration-manager.js'
import { HaWsClient } from './ha-ws-client.js'
import type { HaAuthConfig } from './ha-types.js'

/** Discriminated result of a pre-creation broker handshake probe. The
 *  success branch may carry the connect latency; the failure branch
 *  always carries a human-readable error. Mirrors the `broker.testSettings`
 *  cap output. */
export type HaTestSettingsResult = { ok: true; latencyMs?: number } | { ok: false; error: string }

/** Hard ceiling on a throwaway handshake so a UI spinner can't hang on
 *  an unreachable HA. */
const TEST_HANDSHAKE_TIMEOUT_MS = 8_000

/**
 * Persisted-entry shape for a single HA broker. Stored in the addon's
 * `globalSettings` under the `brokers` key. Long-lived access tokens
 * land verbatim — the production deployment relies on the addon
 * `dataDir` being protected by filesystem permissions. (MQTT broker
 * encrypts at rest; HA broker does not yet — TODO for hardening.)
 */
export const HaBrokerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Either Supervisor (token from env) or long-lived (persisted). */
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('supervisor'), supervisorToken: z.string().meta({ secret: true }) }),
    z.object({
      kind: z.literal('long-lived'),
      baseUrl: z.string(),
      accessToken: z.string().meta({ secret: true }),
    }),
  ]),
  /** Optional FK to the integration record that spawned this broker.
   *  Populated when the wizard's "+ New Integration" flow created the
   *  broker; null when the operator added it via the Settings panel
   *  directly. Used by the integration listener to keep the broker
   *  list in sync with the integrations table (cascade-delete on
   *  integration removal). */
  integrationId: z.string().optional(),
})
export type HaBrokerEntry = z.infer<typeof HaBrokerEntrySchema>

/**
 * Validates a `broker.add` `settings` payload for the HA kind. Accepts:
 *  - `{ baseUrl, accessToken }` → long-lived auth
 *  - `{ supervisorToken }` → supervisor auth (typically env-driven, but
 *    persisting allows the addon to keep working after the env var
 *    rotates out of scope)
 */
const HaAddSettingsSchema = z.union([
  z.object({ baseUrl: z.url(), accessToken: z.string().min(1).meta({ secret: true }) }),
  z.object({ supervisorToken: z.string().min(1).meta({ secret: true }) }),
])

export function settingsToAuth(settings: unknown): HaAuthConfig {
  const parsed = HaAddSettingsSchema.parse(settings)
  if ('supervisorToken' in parsed) {
    return { kind: 'supervisor', supervisorToken: parsed.supervisorToken }
  }
  return { kind: 'long-lived', baseUrl: parsed.baseUrl, accessToken: parsed.accessToken }
}

export function authToSettings(auth: HaAuthConfig): Record<string, unknown> {
  if (auth.kind === 'supervisor') {
    return { supervisorToken: auth.supervisorToken }
  }
  return { baseUrl: auth.baseUrl, accessToken: auth.accessToken }
}

/**
 * Owns a map of `HaIntegrationManager` keyed by broker id. Handles
 * lifecycle (start on add, stop on remove, reconnect on settings
 * update) and exposes the surface the `broker` cap provider routes to.
 */
export class HaBrokerRegistry {
  private readonly managers = new Map<string, HaIntegrationManager>()
  /** `integrationId → brokerId` index. Populated when a broker entry
   *  that carries an `integrationId` FK starts; cleared on removeEntry.
   *  Drives the generic `device-adoption` cap's integrationId-keyed
   *  lookups (the cap addresses brokers by their owning integration). */
  private readonly integrationToBroker = new Map<string, string>()
  /** Running counter for progressive broker ids (`ha_001`, `ha_002`,
   *  …). Seeded from existing entries on restore so the addon never
   *  reuses an id after a restart. */
  private nextIdCounter = 1
  /** Broker → integration warm hook. Invoked with the brokerId each time a
   *  broker's WS reaches `connected`. Set by the addon to refresh that
   *  broker's discovery cache. In-process; never the system event bus. */
  private onBrokerConnected: ((brokerId: string) => void) | null = null
  /** Broker → integration disconnect hook. Invoked with the brokerId each time
   *  a broker's WS drops. Set by the addon to mark that broker's child devices
   *  offline. In-process; never the system event bus. */
  private onBrokerDisconnected: ((brokerId: string) => void) | null = null
  /** Broker → integration bus-event hook (Case 2). Invoked with the brokerId +
   *  the curated bus event each time a manager fires one. Set by the addon to
   *  route the event onto the per-broker generic `EventEmitter` aggregator.
   *  In-process; never the system event bus. */
  private onBrokerBusEvent: ((brokerId: string, ev: HaBusEventEnvelope) => void) | null = null

  constructor(
    private readonly logger: IScopedLogger,
    private readonly eventBus: IEventBus,
  ) {}

  /** Register the broker → integration connect hook (warm-on-connect). Must
   *  be set before `restore` so brokers connecting during bootstrap fire it. */
  setOnBrokerConnected(handler: (brokerId: string) => void): void {
    this.onBrokerConnected = handler
  }

  /** Register the broker → integration disconnect hook (mark-children-offline).
   *  Must be set before `restore` so brokers that drop during bootstrap fire it. */
  setOnBrokerDisconnected(handler: (brokerId: string) => void): void {
    this.onBrokerDisconnected = handler
  }

  /** Register the broker → integration bus-event hook (Case 2 aggregator
   *  routing). Must be set before `restore` so brokers connecting during
   *  bootstrap fire it. */
  setOnBusEvent(handler: (brokerId: string, ev: HaBusEventEnvelope) => void): void {
    this.onBrokerBusEvent = handler
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────

  /** Restore persisted broker entries on addon boot. Each entry is
   *  started concurrently; transient errors don't block bootstrap. */
  async restore(entries: readonly HaBrokerEntry[]): Promise<void> {
    this.seedCounterFromEntries(entries)
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await this.startManagerForEntry(entry)
        } catch (err) {
          this.logger.warn('ha-broker bootstrap failed', {
            meta: { brokerId: entry.id, error: errMsg(err) },
          })
        }
      }),
    )
  }

  /** Pick the next progressive id (`ha_001`, `ha_002`, …). Exposed so
   *  the addon's onConfigChanged reconciler can stamp new persistence
   *  rows that arrived without an id (form save path). */
  allocateId(): string {
    const id = `ha_${String(this.nextIdCounter).padStart(3, '0')}`
    this.nextIdCounter += 1
    return id
  }

  /**
   * Take a caller-supplied id, or refuse.
   *
   * Two refusals, and both matter more than they look:
   *
   *  - **An id already in use** would SILENTLY take over a live broker: the new
   *    entry replaces it in config while its devices keep pointing at the id,
   *    now serving someone else's Home Assistant. Recovery is re-creating a
   *    broker that is GONE, never overwriting one that is here.
   *  - **The progressive counter is advanced past an adopted id.** Adopting
   *    `ha_004` while the counter sits at 2 would let the next automatic
   *    allocation mint `ha_004` a second time — two brokers, one id, and every
   *    device bound to whichever won. The counter is only seeded from stored
   *    entries at load, so it cannot discover this on its own.
   */
  adoptId(id: string): string {
    // `managers` is the registry's own index of live brokers — every entry that
    // loaded got one, so "has a manager" is "this id is taken".
    if (this.managers.has(id)) {
      throw new Error(
        `broker id "${id}" is already in use — adopt an id only to restore a broker that is gone`,
      )
    }
    const match = id.match(/^ha_(\d+)$/)
    if (match) {
      this.nextIdCounter = Math.max(this.nextIdCounter, Number.parseInt(match[1]!, 10) + 1)
    }
    return id
  }

  private seedCounterFromEntries(entries: readonly HaBrokerEntry[]): void {
    let maxSeen = 0
    for (const e of entries) {
      const match = e.id.match(/^ha_(\d+)$/)
      if (match) maxSeen = Math.max(maxSeen, Number.parseInt(match[1]!, 10))
    }
    this.nextIdCounter = maxSeen + 1
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.managers.values()].map((m) => m.stop()))
    this.managers.clear()
  }

  // ── Registry CRUD ─────────────────────────────────────────────────────

  /** Create a new broker entry. Caller persists `entries()` to addon
   *  globalSettings; this method only starts the manager.
   *  `integrationId` is supplied by the integration→broker reconciler
   *  when the entry mirrors an integration record. */
  async createEntry(
    name: string,
    settings: unknown,
    options: { integrationId?: string; id?: string } = {},
  ): Promise<HaBrokerEntry> {
    const auth = settingsToAuth(settings)
    const entry: HaBrokerEntry = {
      id: options.id !== undefined ? this.adoptId(options.id) : this.allocateId(),
      name,
      auth,
      ...(options.integrationId !== undefined ? { integrationId: options.integrationId } : {}),
    }
    await this.startManagerForEntry(entry)
    return entry
  }

  async removeEntry(id: string): Promise<void> {
    // Clear the integration index BEFORE the manager early-return: a broker
    // linked via `linkIntegration` whose manager never started would otherwise
    // leak a stale `integrationToBroker` entry forever.
    for (const [integrationId, brokerId] of this.integrationToBroker) {
      if (brokerId === id) this.integrationToBroker.delete(integrationId)
    }
    const mgr = this.managers.get(id)
    if (!mgr) return
    await mgr.stop()
    this.managers.delete(id)
  }

  async updateEntry(id: string, settings: unknown): Promise<HaBrokerEntry> {
    const existing = this.managers.get(id)
    if (!existing) throw new Error(`ha-broker '${id}' not found`)
    const auth = settingsToAuth(settings)
    await existing.applyAuth(auth)
    return { id, name: existing.getInfo().name, auth }
  }

  /**
   * Pre-creation handshake probe. Builds a throwaway auth from a flat
   * settings payload (the same shape `settingsToAuth` accepts), opens a
   * disposable `HaWsClient`, awaits the WS handshake, and tears the
   * client down. Never throws — every failure (invalid settings,
   * unreachable host, auth rejection, timeout) resolves to
   * `{ ok: false, error }`. On success returns `{ ok: true, latencyMs }`.
   */
  async testSettings(settings: unknown): Promise<HaTestSettingsResult> {
    let auth: HaAuthConfig
    try {
      auth = settingsToAuth(settings)
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }

    const startedAt = Date.now()
    let resolved = false
    // Hoisted so both the probe callbacks AND the timeout branch can tear
    // the throwaway client down. `HaWsClient.stop()` is idempotent and the
    // `resolved` guard prevents a double-resolve, so calling stop() from
    // whichever branch wins (and again from a late callback) is safe.
    let client: HaWsClient | null = null
    // Hoisted timer handle so the probe-wins path can clear the pending
    // timeout, preventing it from firing (and holding the event loop) later.
    let timer: ReturnType<typeof setTimeout> | null = null

    const probe = new Promise<HaTestSettingsResult>((resolve) => {
      client = new HaWsClient({
        auth,
        callbacks: {
          onConnected: () => {
            if (resolved) return
            resolved = true
            if (timer) clearTimeout(timer)
            client?.stop()
            resolve({ ok: true, latencyMs: Date.now() - startedAt })
          },
          onDisconnected: () => {
            if (resolved) return
            resolved = true
            if (timer) clearTimeout(timer)
            client?.stop()
            resolve({ ok: false, error: 'Disconnected before authentication' })
          },
          onReconnectError: (err) => {
            if (resolved) return
            resolved = true
            if (timer) clearTimeout(timer)
            client?.stop()
            resolve({ ok: false, error: errMsg(err) })
          },
        },
      })
      client.start().catch((err: unknown) => {
        if (resolved) return
        resolved = true
        if (timer) clearTimeout(timer)
        client?.stop()
        resolve({ ok: false, error: errMsg(err) })
      })
    })

    const timeout = new Promise<HaTestSettingsResult>((resolve) => {
      timer = setTimeout(() => {
        if (resolved) return
        resolved = true
        // Stop the throwaway client so the timeout branch doesn't leak the
        // open connection + the client's own backoff/reconnect timer.
        client?.stop()
        resolve({ ok: false, error: `Timed out after ${TEST_HANDSHAKE_TIMEOUT_MS}ms` })
      }, TEST_HANDSHAKE_TIMEOUT_MS)
      // Don't let this timer hold the process event loop open on its own.
      if (typeof timer.unref === 'function') timer.unref()
    })

    return Promise.race([probe, timeout])
  }

  list(): HaBrokerInfo[] {
    return [...this.managers.values()].map((m) => m.getInfo())
  }

  get(id: string): HaBrokerInfo | null {
    const mgr = this.managers.get(id)
    return mgr ? mgr.getInfo() : null
  }

  /** Number of brokers in the registry — drives `getStatus.brokerCount`. */
  size(): number {
    return this.managers.size
  }

  /** Number of brokers with `status === 'connected'`. */
  connectedSize(): number {
    let n = 0
    for (const m of this.managers.values()) {
      if (m.getInfo().status === 'connected') n += 1
    }
    return n
  }

  // ── Cap surface delegation ────────────────────────────────────────────

  async publish(brokerId: string, target: PublishTargetHa, payload: unknown): Promise<unknown> {
    return this.requireManager(brokerId).publish(target, payload)
  }

  async subscribe(
    brokerId: string,
    filter: SubscribeFilterHa,
  ): Promise<{ subscriptionId: string }> {
    return this.requireManager(brokerId).subscribe(filter)
  }

  async unsubscribe(brokerId: string, subscriptionId: string): Promise<void> {
    return this.requireManager(brokerId).unsubscribe(subscriptionId)
  }

  getState(brokerId: string, key: string): unknown | null {
    return this.requireManager(brokerId).getState(key)
  }

  /** Discovery surface (Phase E3) reads the full state snapshot through
   *  this method. Returns `null` when the broker is not registered. */
  snapshotAllStates(brokerId: string): Record<string, unknown> | null {
    const mgr = this.managers.get(brokerId)
    if (!mgr) return null
    return mgr.snapshotAllStates()
  }

  /**
   * Direct manager access for in-process services (the HA discovery
   * service that needs to issue raw `config/*_registry/list` WS calls).
   * Cross-process consumers go through the `broker` cap surface.
   */
  getManager(brokerId: string): HaIntegrationManager | null {
    return this.managers.get(brokerId) ?? null
  }

  /**
   * Enumerate every active (brokerId, integrationId?, manager) triple.
   * Used by the device-provider discovery path to fan out
   * `config/device_registry/list` + `config/entity_registry/list`
   * calls across every connected broker and collect candidates.
   *
   * `integrationId` is present when the broker was linked to a CamStack
   * integration record via `linkIntegration`; absent when the broker was
   * added manually (no integration FK).
   */
  listManagers(): readonly {
    brokerId: string
    integrationId: string | undefined
    manager: HaIntegrationManager
  }[] {
    const out: {
      brokerId: string
      integrationId: string | undefined
      manager: HaIntegrationManager
    }[] = []
    // Build a reverse map from brokerId → integrationId (may be undefined)
    const brokerToIntegration = new Map<string, string>()
    for (const [integrationId, brokerId] of this.integrationToBroker) {
      brokerToIntegration.set(brokerId, integrationId)
    }
    for (const [brokerId, manager] of this.managers) {
      out.push({ brokerId, integrationId: brokerToIntegration.get(brokerId), manager })
    }
    return out
  }

  /**
   * Resolve the broker id for an integration via its `integrationId` FK.
   * Throws a clear error when no broker is linked — adoption operations
   * keyed by integrationId need a concrete broker to dial.
   */
  getBrokerIdByIntegrationId(integrationId: string): string {
    const brokerId = this.integrationToBroker.get(integrationId)
    if (brokerId === undefined) {
      throw new Error(`ha-broker: no broker linked to integration '${integrationId}'`)
    }
    return brokerId
  }

  /**
   * Record an `integrationId → brokerId` link. Called by the addon's
   * integration→broker reconciler when it tags an EXISTING broker (one
   * that started without an `integrationId` FK on its persisted entry)
   * to an integration. `createEntry`/`startManagerForEntry` already
   * index entries that carry the FK at start time, so this only fills
   * the late-link gap.
   */
  linkIntegration(integrationId: string, brokerId: string): void {
    this.integrationToBroker.set(integrationId, brokerId)
  }

  // ── Private ───────────────────────────────────────────────────────────

  private requireManager(brokerId: string): HaIntegrationManager {
    const mgr = this.managers.get(brokerId)
    if (!mgr) throw new Error(`ha-broker '${brokerId}' not found`)
    return mgr
  }

  private async startManagerForEntry(entry: HaBrokerEntry): Promise<void> {
    // A broker is unique per id. If one is already active, KEEP it — its live
    // WS connection + subscription map must not be torn down and replaced by a
    // duplicate. Only (re)create when the id has no manager yet. We still
    // (re)assert the integration-index link in case the entry's FK changed.
    const existing = this.managers.get(entry.id)
    if (existing) {
      if (entry.integrationId !== undefined) {
        this.integrationToBroker.set(entry.integrationId, entry.id)
      }
      this.logger.debug('ha-broker already active — reusing existing connection', {
        meta: { brokerId: entry.id },
      })
      return
    }
    const manager = new HaIntegrationManager({
      id: entry.id,
      name: entry.name,
      auth: entry.auth,
      logger: this.logger,
      eventBus: this.eventBus,
      onConnected: (brokerId) => this.onBrokerConnected?.(brokerId),
      onDisconnected: (brokerId) => this.onBrokerDisconnected?.(brokerId),
      onBusEvent: (brokerId, ev) => this.onBrokerBusEvent?.(brokerId, ev),
    })
    this.managers.set(entry.id, manager)
    if (entry.integrationId !== undefined) {
      this.integrationToBroker.set(entry.integrationId, entry.id)
    }
    await manager.start()
  }
}
