import type { Alert, AlertSeverity, AlertStatus, ConfigUISchema } from '@camstack/types'
import {
  AlertSchema,
  alertEpisodeId,
  alertEpisodePayload,
  alertsCapability,
  BaseAddon,
  createEvent,
  EventCategory,
  errMsg,
  type KnownEventCategory,
  type ProviderRegistration,
  type SystemEvent,
} from '@camstack/types'
import { episodeEdge, nextEpisodeId, type EpisodeView } from './alert-episode-policy.js'
import { episodeKeyFromMetadata, mergeEmitAlert } from './emit-alert-policy.js'
import { deviceLabelFromEventData } from './device-label.js'
import { type PrunableAlert, selectExpired, selectOverflow } from './prune-policy.js'
import {
  foldRunnerEvent,
  isRunnerAlertCategory,
  renderRunnerAlert,
  runnerAlertId,
  runnerKeyOf,
  type RunnerAlertRecord,
  type RunnerAlertState,
} from './runner-alert.js'
import { AlertStore } from './alert-store.js'
import { alertCenterRecordKinds } from './record-kinds.js'

// ── Category → severity mapping ─────────────────────────────────────
//
// Alert Center is for things an operator must ACT on or notice: crashes,
// package/node updates, dead streams, storage, agents going away. Routine
// noise (every boot, every agent reconnect, every settings write that
// reuses `addon.updated`, every device adoption) belongs in the event
// stream / Notification Center rules — not the bell.

interface CategoryMapping {
  readonly severity: AlertSeverity
  readonly titleTemplate: string
}

const CATEGORY_MAPPINGS: Readonly<Record<string, CategoryMapping>> = {
  // ── Crashes / hard faults ─────────────────────────────────────────
  'addon.crashed': { severity: 'error', titleTemplate: 'Addon crashed' },
  'addon.runner-failed': { severity: 'error', titleTemplate: 'Addon crash loop' },
  'addon.runner-refused': { severity: 'error', titleTemplate: 'Addon refused to start' },
  'system.runner-check': { severity: 'error', titleTemplate: 'Runners degraded' },
  'addon.error': { severity: 'error', titleTemplate: 'Addon error' },
  'process.crashed': { severity: 'error', titleTemplate: 'Process crashed' },
  'recording.error': { severity: 'error', titleTemplate: 'Recording error' },
  'recording.storage.critical': { severity: 'warning', titleTemplate: 'Storage critical' },
  'notification.failed': { severity: 'error', titleTemplate: 'Notification failed' },

  // ── Cluster — disconnect only (connect is expected) ───────────────
  'agent.offline': { severity: 'warning', titleTemplate: 'Agent disconnected' },

  // ── Node / package updates ────────────────────────────────────────
  'system.restarting': { severity: 'warning', titleTemplate: 'System restarting' },
  'system.restart-completed': { severity: 'info', titleTemplate: 'Node updated' },
  'update.available': { severity: 'info', titleTemplate: 'Update available' },
  // The hub's own certificate changed — anyone who trusted the previous
  // one by hand has to act. Never silent.
  'system.tls-cert-changed': { severity: 'warning', titleTemplate: 'TLS certificate changed' },

  // ── Device remove (add is expected operator work) ─────────────────
  'device.unregistered': { severity: 'warning', titleTemplate: 'Device unregistered' },

  // ── Package management (version-bearing `addon.updated` only) ─────
  'addon.installed': { severity: 'info', titleTemplate: 'Addon installed' },
  'addon.updated': { severity: 'info', titleTemplate: 'Addon updated' },
  'addon.uninstalled': { severity: 'info', titleTemplate: 'Addon uninstalled' },

  // ── Addon / node health (stable-id merge paths) ───────────────────
  'addon.load-failed': { severity: 'error', titleTemplate: 'Addon failed to load' },
  'system.liveness-failed': { severity: 'error', titleTemplate: 'Node liveness' },

  // ── Streams — only real outages (`stale-timeout`); see handler ────
  'stream.offline': { severity: 'warning', titleTemplate: 'Stream offline' },

  // ── A notification rule that cannot work (D905) — one card per rule ──
  'notification.rule-broken': { severity: 'warning', titleTemplate: 'Notification rule broken' },

  // ── Backup restore (completed backups are routine) ────────────────
  'backup.restored': { severity: 'info', titleTemplate: 'Backup restored' },

  // ── Model downloads (in-progress merging path) ────────────────────
  'model.download.progress': { severity: 'info', titleTemplate: 'Model download' },
}

/**
 * Subscribed for dismiss / merge side-effects only — never mint a card.
 * Must stay in the subscribe set even though they are absent from
 * {@link CATEGORY_MAPPINGS}.
 */
const SILENT_TRACKED_CATEGORIES: readonly string[] = [
  // A runner reaching `running` closes its runner alert (D877).
  'process.state-changed',
  'addon.load-recovered',
  'system.liveness-recovered',
  'stream.online',
  // A repaired rule closes its broken-rule card (D905).
  'notification.rule-repaired',
]

/** The `stream.offline` reasons that are an outage (D883) — mirrors the broker's `isStreamOutageReason`. */
const STREAM_OUTAGE_REASONS: readonly string[] = [
  'stale-timeout',
  'wake-timeout',
  'connection-error',
  'battery-unreachable',
]

/** The streams an offline event covers: its list, else the one stream it names. */
function streamIdsOf(listed: unknown, fallback: string | undefined): readonly string[] {
  if (Array.isArray(listed)) {
    const ids = listed.filter((id): id is string => typeof id === 'string')
    if (ids.length > 0) return ids
  }
  return fallback !== undefined ? [fallback] : []
}

const TRACKED_CATEGORIES = [...Object.keys(CATEGORY_MAPPINGS), ...SILENT_TRACKED_CATEGORIES]

/**
 * `[ALERT-CENTER-EVENTS]` — rate limiting. Events that fire thousands of
 * times a minute (flaky cam reconnecting, chatty integration, …) would
 * flood the alert feed and push genuinely important alerts off the
 * visible page. We collapse bursts into a single throttled summary per
 * `(category, source.id)` tuple: the first N events within the window
 * still surface as individual alerts, but once the source crosses the
 * threshold we stop emitting alerts for it and wait out the window.
 *
 * A standalone category-count map is cleared on every window rollover.
 * Keep the threshold generous enough that legitimate bursts of ~a few
 * per minute still get through, but strict enough that a reconnect loop
 * firing every second gets muted.
 */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_PER_SOURCE = 5

/** The alert `category` a runner record carries - the state it is in. */
function runnerCategoryOf(state: RunnerAlertState): string {
  return state === 'refused'
    ? 'addon.runner-refused'
    : state === 'failed'
      ? 'addon.runner-failed'
      : 'addon.crashed'
}

function parseRunnerRecord(value: unknown): RunnerAlertRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const rec = value as Record<string, unknown>
  const state = rec['state']
  if (
    typeof rec['nodeId'] !== 'string' ||
    typeof rec['runnerId'] !== 'string' ||
    (state !== 'crashed' && state !== 'failed' && state !== 'refused') ||
    typeof rec['count'] !== 'number' ||
    !Array.isArray(rec['addonIds'])
  ) {
    return null
  }
  return {
    nodeId: rec['nodeId'],
    runnerId: rec['runnerId'],
    state,
    since: typeof rec['since'] === 'number' ? rec['since'] : 0,
    count: rec['count'],
    addonIds: rec['addonIds'].filter((x): x is string => typeof x === 'string'),
    ...(typeof rec['lastError'] === 'string' ? { lastError: rec['lastError'] } : {}),
    ...(typeof rec['reason'] === 'string' ? { reason: rec['reason'] } : {}),
    ...(typeof rec['remedy'] === 'string' ? { remedy: rec['remedy'] } : {}),
    ...(typeof rec['crashesInWindow'] === 'number'
      ? { crashesInWindow: rec['crashesInWindow'] }
      : {}),
  }
}

/** Parse a raw settings record into a validated Alert. */
function parseAlert(record: { id: string; data: Record<string, unknown> }): Alert {
  return AlertSchema.parse({ id: record.id, ...record.data })
}

// ── Alert Center Addon ─────────────────────────────────────────────

interface AlertCenterConfig {
  readonly maxAlerts: number
  readonly retentionDays: number
}

const DEFAULT_CONFIG: AlertCenterConfig = {
  maxAlerts: 500,
  retentionDays: 30,
}

const EVENT_SOURCE = { type: 'addon', id: 'alert-center' } as const

/** Where the operator acts on a runner that failed, was refused or is missing. */
const ADDONS_PAGE_ACTION = {
  label: 'Open Addons',
  href: '/system/addons',
} as const

function episodeViewOf(alert: Alert): EpisodeView {
  const key = episodeKeyFromMetadata(alert.metadata)
  return {
    status: alert.status,
    severity: alert.severity,
    episodeId: alertEpisodeId(alert),
    ...(key !== undefined ? { episodeKey: key } : {}),
  }
}

/**
 * Alert Center addon — core builtin that persists alerts in a
 * structured SQLite table and serves them to the admin UI.
 *
 * Registers as an `alerts` collection provider and subscribes to
 * important EventBus categories to create/update alerts automatically.
 */
/** Project a stored alert row onto the fields the prune policy needs. */
function toPrunable(record: {
  readonly id: string
  readonly data: Record<string, unknown>
}): PrunableAlert {
  return {
    id: record.id,
    createdAt: Number(record.data['createdAt'] ?? 0),
    read: record.data['read'] === true,
  }
}

export class AlertCenterAddon extends BaseAddon<AlertCenterConfig> {
  private alertStore: AlertStore | null = null
  private unsubscribers: readonly (() => void)[] = []

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  /**
   * Per `(category, source.id)` counter used to rate-limit chatty
   * events. Entries are pruned lazily when they age out of
   * `RATE_LIMIT_WINDOW_MS`; see `shouldSuppressByRate()` below.
   */
  private readonly rateLimitCounters = new Map<
    string,
    { firstAt: number; count: number; suppressedLogged: boolean }
  >()

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    const store = this.ctx.api?.settingsStore
    if (records !== undefined) await records.declare(alertCenterRecordKinds)
    this.alertStore =
      records !== undefined
        ? AlertStore.of(records)
        : store === undefined
          ? null
          : AlertStore.legacy(store)
    if (this.alertStore === null) {
      throw new Error('alert-center needs ctx.records or settings-store on the hub')
    }

    const alertsProvider = {
      emit: (alert: Alert) => this.emitAlert(alert),
      update: (input: { alertId: string; patch: Partial<Alert> }) =>
        this.updateAlert(input.alertId, input.patch),
      list: (filter?: { unreadOnly?: boolean; limit?: number }) => this.listAlerts(filter),
      getUnreadCount: () => this.getUnreadCount(),
      markRead: (input: { alertId: string }) => this.markRead(input.alertId),
      markAllRead: () => this.markAllRead(),
      dismiss: (input: { alertId: string }) => this.dismiss(input.alertId),
    }

    const unsubs: (() => void)[] = []
    for (const category of TRACKED_CATEGORIES) {
      const unsub = this.ctx.eventBus.subscribe(
        { category: category as KnownEventCategory },
        (event: SystemEvent) => {
          void this.handleEvent(category, event)
        },
      )
      unsubs.push(unsub)
    }
    this.unsubscribers = unsubs
    // One-time migration of state keys (D883): cards opened per cam-stream.
    void this.dismissLegacyStreamCards(undefined)

    this.ctx.logger.info('Initialized', {
      meta: { trackedCategoriesCount: TRACKED_CATEGORIES.length },
    })
    return [{ capability: alertsCapability, provider: alertsProvider }]
  }

  protected async onShutdown(): Promise<void> {
    for (const unsub of this.unsubscribers) {
      unsub()
    }
    this.unsubscribers = []
  }

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'alerts',
          title: 'Alert Center',
          titleKey: 'server:globalSettings.s_alerts.title',
          description: 'Configure alert storage and retention.',
          descriptionKey: 'server:globalSettings.s_alerts.description',
          columns: 1,
          fields: [
            this.field({
              type: 'number',
              key: 'maxAlerts',
              label: 'Maximum stored alerts',
              labelKey: 'server:globalSettings.s_alerts.maxAlerts.label',
              description: 'Oldest read alerts are deleted when this limit is exceeded.',
              descriptionKey: 'server:globalSettings.s_alerts.maxAlerts.description',
              min: 50,
              max: 5000,
              step: 50,
              default: 500,
            }),
            this.field({
              type: 'number',
              key: 'retentionDays',
              label: 'Alert retention (days)',
              labelKey: 'server:globalSettings.s_alerts.retentionDays.label',
              description: 'Alerts older than this are automatically removed.',
              descriptionKey: 'server:globalSettings.s_alerts.retentionDays.description',
              min: 1,
              max: 365,
              step: 1,
              default: 30,
            }),
          ],
        },
      ],
    })
  }

  // ── Public methods (called by the tRPC router) ────────────────────

  async listAlerts(filter?: { unreadOnly?: boolean; limit?: number }): Promise<readonly Alert[]> {
    const store = this.alertStore
    if (store === null) return []
    const rows = await store.list(filter)
    return rows.map(parseAlert)
  }

  async getUnreadCount(): Promise<number> {
    const store = this.alertStore
    if (store === null) return 0
    return store.countUnread()
  }

  async markRead(alertId: string): Promise<void> {
    await this.mergeUpdate(alertId, { read: true, updatedAt: Date.now() })
  }

  async markAllRead(): Promise<void> {
    const store = this.alertStore
    if (store === null) return

    const unread = await store.list({ unreadOnly: true, limit: 10_000 })
    const now = Date.now()
    for (const record of unread) {
      await this.mergeUpdate(record.id, { read: true, updatedAt: now })
    }
  }

  async dismiss(alertId: string): Promise<void> {
    await this.mergeUpdate(alertId, {
      status: 'dismissed' satisfies AlertStatus,
      read: true,
      updatedAt: Date.now(),
    })
  }

  // ── Private: event handling ──────────────────────────────────────

  /**
   * Events are handled one at a time: every handler is a read-modify-write of
   * an alert, and two concurrent events about one runner would both read "no
   * alert yet" and open two episodes for it.
   */
  private eventChain: Promise<void> = Promise.resolve()

  private handleEvent(category: string, event: SystemEvent): Promise<void> {
    this.eventChain = this.eventChain.then(() => this.processEvent(category, event))
    return this.eventChain
  }

  private async processEvent(category: string, event: SystemEvent): Promise<void> {
    try {
      if (category === 'model.download.progress') {
        // Model download progress has its own in-progress merging path
        // that intentionally overwrites a single alert per model, so
        // rate limiting does not apply here — the merger itself is the
        // collapse mechanism.
        await this.handleModelDownload(event)
        return
      }

      if (isRunnerAlertCategory(category)) {
        await this.handleRunnerEvent(category, event)
        return
      }
      if (category === EventCategory.ProcessStateChanged) {
        await this.handleRunnerStateChanged(event)
        return
      }
      if (category === EventCategory.SystemRunnerCheck) {
        await this.handleRunnerCheck(event)
        return
      }
      if (category === EventCategory.AddonLoadFailed) {
        await this.handleAddonLoadFailed(event)
        return
      }
      if (category === EventCategory.AddonLoadRecovered) {
        await this.handleAddonLoadRecovered(event)
        return
      }
      if (category === EventCategory.SystemLivenessFailed) {
        await this.handleLivenessFailed(event)
        return
      }
      if (category === EventCategory.SystemLivenessRecovered) {
        await this.handleLivenessRecovered(event)
        return
      }
      if (category === EventCategory.StreamOffline) {
        await this.handleStreamOffline(event)
        return
      }
      if (category === EventCategory.StreamOnline) {
        await this.handleStreamOnline(event)
        return
      }
      if (category === EventCategory.NotificationRuleBroken) {
        await this.handleRuleBroken(event)
        return
      }
      if (category === EventCategory.NotificationRuleRepaired) {
        await this.handleRuleRepaired(event)
        return
      }

      const mapping = CATEGORY_MAPPINGS[category]
      if (!mapping) return

      // Settings saves also emit `addon.updated` (`BaseAddon.updateGlobalSettings`
      // with `{ level: 'global' }` and no versions). Notification Center already
      // drops those — `toVersion` is the discriminator. Alert Center used to
      // mint a fresh UUID per save, so exporters that write settings in a burst
      // filled the bell with identical "Addon X updated" cards. Skip them here
      // too; only a package version change is an alert.
      if (category === 'addon.updated') {
        const toVersion = event.data['toVersion']
        if (typeof toVersion !== 'string' || toVersion.length === 0) return
      }

      if (this.shouldSuppressByRate(category, event)) return

      const message = this.buildMessage(
        category,
        event.data,
        event.source ? String(event.source.id) : undefined,
      )
      const addonIdForKey =
        (typeof event.data['addonId'] === 'string' ? event.data['addonId'] : undefined) ??
        (event.source ? String(event.source.id) : undefined)
      const toVersionForKey =
        typeof event.data['toVersion'] === 'string' ? event.data['toVersion'] : undefined
      // One card per (addon, toVersion): a package deploy that emits once per
      // member addon still needs distinct cards, but a double-emit of the same
      // version must not stack.
      const alertId =
        category === 'addon.updated' && addonIdForKey !== undefined && toVersionForKey !== undefined
          ? `addon-updated:${addonIdForKey}:${toVersionForKey}`
          : crypto.randomUUID()
      const alert: Alert = {
        id: alertId,
        category,
        severity: mapping.severity,
        title: mapping.titleTemplate,
        message,
        status: 'active',
        read: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: event.source ? { type: event.source.type, id: String(event.source.id) } : undefined,
        metadata: event.data,
      }

      await this.emitAlert(alert)
    } catch (err) {
      this.ctx.logger?.warn('Failed to handle event', { meta: { category, error: errMsg(err) } })
    }
  }

  // ── Runner alerts: ONE per runner (D877) ─────────────────────────

  private async readRunnerRecord(alertId: string): Promise<RunnerAlertRecord | null> {
    const store = this.alertStore
    if (store === null) return null
    const raw = await store.getData(alertId)
    if (raw === null) return null
    const alert = AlertSchema.safeParse({ id: alertId, ...raw })
    // A dismissed alert starts a fresh record.
    if (!alert.success || alert.data.status === 'dismissed') return null
    return parseRunnerRecord(alert.data.metadata?.['runner'])
  }

  private async handleRunnerEvent(category: string, event: SystemEvent): Promise<void> {
    if (!isRunnerAlertCategory(category)) return
    const key = runnerKeyOf(
      category,
      event.data,
      event.source
        ? {
            id: String(event.source.id),
            ...(typeof event.source.nodeId === 'string' ? { nodeId: event.source.nodeId } : {}),
          }
        : undefined,
    )
    if (key === null) return
    const alertId = runnerAlertId(key.nodeId, key.runnerId)
    const previous = await this.readRunnerRecord(alertId)
    const record = foldRunnerEvent(previous, category, event.data, key, Date.now())
    const rendered = renderRunnerAlert(record)
    const existing = await this.readAlertRaw(alertId)
    const now = Date.now()
    const alert: Alert = {
      id: alertId,
      category: runnerCategoryOf(record.state),
      severity: rendered.severity,
      title: rendered.title,
      message: rendered.message,
      status: 'active',
      // A state change is news again; a mere count bump is not.
      read: previous !== null && previous.state === record.state ? existing?.read === true : false,
      createdAt: previous !== null ? (existing?.createdAt ?? now) : now,
      updatedAt: now,
      source: event.source
        ? { type: event.source.type, id: String(event.source.id) }
        : { type: 'runner', id: record.runnerId },
      action: ADDONS_PAGE_ACTION,
      metadata: { runner: record },
    }
    await this.persistAlert(alert)
    if (previous === null) this.emitAlertCreatedEvent(alert)
    else this.emitAlertUpdatedEvent(alertId, { message: alert.message, title: alert.title })
    await this.enforceMaxAlerts()
  }

  /**
   * A runner reached `running`: its episode is over. Close the runner alert so a
   * later failure opens a NEW episode, instead of folding into a stale
   * `refused` record whose notification was already sent.
   */
  private async handleRunnerStateChanged(event: SystemEvent): Promise<void> {
    if (event.data['state'] !== 'running') return
    const runnerId = typeof event.data['runnerId'] === 'string' ? event.data['runnerId'] : null
    if (runnerId === null) return
    const nodeId = typeof event.data['nodeId'] === 'string' ? event.data['nodeId'] : 'hub'
    const alertId = runnerAlertId(nodeId, runnerId)
    if ((await this.readRunnerRecord(alertId)) === null) return
    await this.dismiss(alertId)
  }

  /** The node's one-shot runner boot check: one alert, dismissed when the node is clean. */
  private async handleRunnerCheck(event: SystemEvent): Promise<void> {
    const nodeId = typeof event.data['nodeId'] === 'string' ? event.data['nodeId'] : 'hub'
    const alertId = `runner-check:${nodeId}`
    if (event.data['degraded'] !== true) {
      await this.dismiss(alertId)
      return
    }
    const summary = typeof event.data['summary'] === 'string' ? event.data['summary'] : 'degraded'
    const ids = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
    const refusedIds = Array.isArray(event.data['refused'])
      ? event.data['refused'].flatMap((r: unknown) => {
          const id =
            typeof r === 'object' && r !== null
              ? (r as Record<string, unknown>)['runnerId']
              : undefined
          return typeof id === 'string' ? [id] : []
        })
      : []
    const failedIds = ids(event.data['failed'])
    const missingIds = ids(event.data['missing'])
    const parts = [
      ...(failedIds.length > 0 ? [`failed: ${failedIds.join(', ')}`] : []),
      ...(refusedIds.length > 0 ? [`refused: ${refusedIds.join(', ')}`] : []),
      ...(missingIds.length > 0 ? [`missing: ${missingIds.join(', ')}`] : []),
    ]
    const now = Date.now()
    const existing = await this.readAlertRaw(alertId)
    const alert: Alert = {
      id: alertId,
      category: 'system.runner-check',
      severity: 'critical',
      title: 'Runners degraded',
      message: `${nodeId}: ${summary}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`,
      action: ADDONS_PAGE_ACTION,
      status: 'active',
      read: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      source: { type: 'node', id: nodeId },
      metadata: {
        nodeId,
        failed: event.data['failed'],
        refused: event.data['refused'],
        missing: event.data['missing'],
      },
    }
    await this.persistAlert(alert)
    this.emitAlertCreatedEvent(alert)
  }

  private async readAlertRaw(alertId: string): Promise<{
    createdAt?: number
    read?: boolean
    episodeKey?: string
    status?: string
    episode?: EpisodeView
  } | null> {
    const store = this.alertStore
    if (store === null) return null
    const raw = await store.getData(alertId)
    if (raw === null) return null
    const rec: Record<string, unknown> = Object.fromEntries(Object.entries(raw))
    const meta = rec['metadata']
    const metadata =
      typeof meta === 'object' && meta !== null && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : undefined
    const parsed = AlertSchema.safeParse({ id: alertId, ...rec })
    return {
      ...(typeof rec['createdAt'] === 'number' ? { createdAt: rec['createdAt'] } : {}),
      ...(typeof rec['read'] === 'boolean' ? { read: rec['read'] } : {}),
      ...(typeof rec['status'] === 'string' ? { status: rec['status'] } : {}),
      ...(episodeKeyFromMetadata(metadata) !== undefined
        ? { episodeKey: episodeKeyFromMetadata(metadata) }
        : {}),
      ...(parsed.success ? { episode: episodeViewOf(parsed.data) } : {}),
    }
  }

  private async handleModelDownload(event: SystemEvent): Promise<void> {
    const data = event.data
    const modelId = (data.modelId as string | undefined) ?? 'unknown'
    const progress = (data.progress as number | undefined) ?? 0
    const stableId = `model-download:${modelId}`

    const store = this.alertStore
    if (store === null) return

    const existingRow = await store.getData(stableId)

    if (existingRow !== null) {
      // Update existing alert (read-merge-write)
      const now = Date.now()
      if (progress >= 100) {
        await this.mergeUpdate(stableId, {
          status: 'completed' satisfies AlertStatus,
          progress: 100,
          message: `Model "${modelId}" download completed`,
          updatedAt: now,
        })
        this.emitAlertUpdatedEvent(stableId, { status: 'completed', progress: 100 })
      } else if (progress < 0) {
        await this.mergeUpdate(stableId, {
          status: 'failed' satisfies AlertStatus,
          message: `Model "${modelId}" download failed`,
          updatedAt: now,
        })
        this.emitAlertUpdatedEvent(stableId, { status: 'failed' })
      } else {
        await this.mergeUpdate(stableId, {
          progress,
          message: `Downloading model "${modelId}" — ${String(Math.round(progress))}%`,
          updatedAt: now,
        })
        this.emitAlertUpdatedEvent(stableId, { progress })
      }
    } else {
      // Create new in-progress alert
      const alert: Alert = {
        id: stableId,
        category: EventCategory.ModelDownloadProgress,
        severity: 'info',
        title: 'Model download',
        message: `Downloading model "${modelId}" — ${String(Math.round(progress))}%`,
        status: 'in-progress',
        progress,
        read: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: event.source ? { type: event.source.type, id: String(event.source.id) } : undefined,
        metadata: { modelId },
      }

      await this.persistAlert(alert)
      this.emitAlertCreatedEvent(alert)
    }
  }

  /**
   * `[ALERT-CENTER-EVENTS]` — rate limit a `(category, source.id)`
   * tuple. Returns `true` when the caller should DROP this event
   * without persisting an alert, and `false` when the alert should
   * proceed normally.
   *
   * Heuristic: the first `RATE_LIMIT_MAX_PER_SOURCE` events within a
   * `RATE_LIMIT_WINDOW_MS` window go through. Once the threshold is
   * crossed, subsequent events are suppressed until the window rolls
   * over. When the threshold is first crossed, the suppression is
   * logged once so operators know why they're not seeing the follow-
   * up alerts; after the window rolls over the next event is
   * un-suppressed and starts a new window.
   */
  private shouldSuppressByRate(category: string, event: SystemEvent): boolean {
    const sourceId = event.source?.id ?? 'unknown'
    const key = `${category}::${sourceId}`
    const now = Date.now()
    const entry = this.rateLimitCounters.get(key)

    if (!entry || now - entry.firstAt > RATE_LIMIT_WINDOW_MS) {
      // First event of a new window — always allow, start the counter.
      this.rateLimitCounters.set(key, { firstAt: now, count: 1, suppressedLogged: false })
      return false
    }

    entry.count += 1
    if (entry.count <= RATE_LIMIT_MAX_PER_SOURCE) return false

    // Over threshold — suppress the rest of this window.
    if (!entry.suppressedLogged) {
      entry.suppressedLogged = true
      this.ctx.logger?.info('rate-limiting suppressing remainder of window', {
        meta: {
          category,
          sourceId,
          maxPerSource: RATE_LIMIT_MAX_PER_SOURCE,
          windowSeconds: RATE_LIMIT_WINDOW_MS / 1000,
        },
      })
    }
    return true
  }

  /**
   * AddonLoadFailed — kernel's AddonHealthMonitor has post-grace
   * failed an addon load/init. Upsert a stable-id alert keyed by
   * `addon-load-failed:<packageName>` so the recovery path can
   * dismiss it. Severity=error, persistent until dismissed or
   * auto-resolved.
   *
   * The action `retry` carries the package name so the admin UI can
   * dispatch `addons.retryLoad(packageName)` directly from the alert
   * card without the operator opening the Addons page.
   */
  private async handleAddonLoadFailed(event: SystemEvent): Promise<void> {
    const data = event.data
    const packageName = String(data['packageName'] ?? '')
    if (!packageName) return
    const addonId = data['addonId'] as string | undefined
    const errorObj = data['error'] as { message?: string; stack?: string } | undefined
    const retryCount = Number(data['retryCount'] ?? 0)
    const nextRetryAt = data['nextRetryAt'] as number | null | undefined

    const stableId = `addon-load-failed:${packageName}`
    const message = errorObj?.message
      ? `${addonId ? `${addonId} — ` : ''}${errorObj.message}`
      : `Addon ${addonId ?? packageName} failed to load`

    const alert: Alert = {
      id: stableId,
      category: EventCategory.AddonLoadFailed,
      severity: 'error',
      title: `Addon failed: ${addonId ?? packageName}`,
      message,
      status: 'active',
      read: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: { type: 'addon', id: packageName },
      metadata: {
        packageName,
        addonId,
        retryCount,
        nextRetryAt,
        stack: errorObj?.stack,
      },
    }
    await this.emitAlert(alert)
  }

  /**
   * AddonLoadRecovered — addon previously alerting is back to healthy.
   * Dismiss the matching alert so the operator's badge count drops.
   */
  private async handleAddonLoadRecovered(event: SystemEvent): Promise<void> {
    const data = event.data
    const packageName = String(data['packageName'] ?? '')
    if (!packageName) return
    const stableId = `addon-load-failed:${packageName}`
    try {
      await this.dismiss(stableId)
    } catch (err) {
      // Non-fatal: alert may have already been dismissed manually
      // or never created (e.g. recovery during grace period).
      this.ctx.logger?.debug('AddonLoadRecovered: dismiss failed (likely already dismissed)', {
        meta: { stableId, error: errMsg(err) },
      })
    }
  }

  /**
   * SystemLivenessFailed — a liveness invariant of this node is false.
   *
   * `findingId` is already stable across ticks (`liveness:no-devices`,
   * `liveness:no-footage:<deviceId>`, …), so it IS the alert id: an ongoing
   * fault updates one alert instead of producing one every five minutes.
   */
  private async handleLivenessFailed(event: SystemEvent): Promise<void> {
    const data = event.data
    const findingId = String(data['findingId'] ?? '')
    if (!findingId) return
    const deviceId = typeof data['deviceId'] === 'number' ? data['deviceId'] : undefined
    const severity: AlertSeverity = data['severity'] === 'warning' ? 'warning' : 'error'

    const alert: Alert = {
      id: findingId,
      category: EventCategory.SystemLivenessFailed,
      severity,
      title: String(data['title'] ?? 'Node liveness'),
      message: String(data['message'] ?? ''),
      status: 'active',
      read: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: { type: 'liveness', id: findingId },
      metadata: { findingId, ...(deviceId !== undefined ? { deviceId } : {}) },
    }
    await this.emitAlert(alert)
  }

  /** SystemLivenessRecovered — the invariant holds again; drop the alert. */
  private async handleLivenessRecovered(event: SystemEvent): Promise<void> {
    const findingId = String(event.data['findingId'] ?? '')
    if (!findingId) return
    try {
      await this.dismiss(findingId)
    } catch (err) {
      // Non-fatal: may have been dismissed manually, or never raised (a fault
      // that appeared and cleared inside one tick).
      this.ctx.logger?.debug('LivenessRecovered: dismiss failed (likely already dismissed)', {
        meta: { findingId, error: errMsg(err) },
      })
    }
  }

  /**
   * Stream offline — ONLY an outage reason counts: `stale-timeout`, or one of
   * the battery failures (`wake-timeout`, `connection-error`,
   * `battery-unreachable`). Suspend / destroy / idle dial are deliberate and
   * must not ring the bell (same gate NC uses). One card per DEVICE (D883).
   */
  private async handleStreamOffline(event: SystemEvent): Promise<void> {
    const reason = event.data['reason']
    if (typeof reason !== 'string' || !STREAM_OUTAGE_REASONS.includes(reason)) return
    const deviceId = event.data['deviceId']
    const camStreamId = event.data['camStreamId']
    if (typeof deviceId !== 'number') return
    const camStreamIds = streamIdsOf(
      event.data['camStreamIds'],
      typeof camStreamId === 'string' ? camStreamId : undefined,
    )

    const name = await this.resolveDeviceName(deviceId)
    const label = name ?? `Camera ${String(deviceId)}`
    const stableId = `stream-offline:${String(deviceId)}`
    const alert: Alert = {
      id: stableId,
      category: EventCategory.StreamOffline,
      severity: 'warning',
      title: 'Stream offline',
      message: `${label} — ${camStreamIds.length > 0 ? camStreamIds.join(', ') : 'its stream'} stopped sending video (${reason}).`,
      status: 'active',
      read: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: { type: 'device', id: String(deviceId) },
      metadata: {
        deviceId,
        camStreamId,
        camStreamIds,
        reason,
        ...(name !== undefined ? { name } : {}),
      },
    }
    await this.emitAlert(alert)
  }

  /**
   * A notification rule that cannot work (D905) — visible in-app even when no
   * rule listens for `rule-broken`. One card per RULE; a new reason updates it.
   */
  private async handleRuleBroken(event: SystemEvent): Promise<void> {
    const ruleId = event.data['ruleId']
    if (typeof ruleId !== 'string' || ruleId.length === 0) return
    const ruleName = typeof event.data['ruleName'] === 'string' ? event.data['ruleName'] : ruleId
    const reason = typeof event.data['reason'] === 'string' ? event.data['reason'] : 'unknown'
    const listed = event.data['offendingIds']
    const offendingIds = Array.isArray(listed)
      ? listed.filter((id): id is string => typeof id === 'string')
      : []
    const what =
      reason === 'unparseable'
        ? 'cannot be loaded and sends nothing — open it and save it again'
        : reason === 'device-deleted'
          ? `still names a deleted device (${offendingIds.join(', ')}) and was switched off`
          : reason === 'target-deleted'
            ? `still sends to a deleted destination (${offendingIds.join(', ')}) and was switched off`
            : 'cannot work'
    const alert: Alert = {
      id: `nc-rule-broken:${ruleId}`,
      category: EventCategory.NotificationRuleBroken,
      severity: 'warning',
      title: 'Notification rule broken',
      message: `Rule "${ruleName}" ${what}.`,
      status: 'active',
      read: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: { type: 'addon', id: 'notification-center' },
      metadata: { ruleId, ruleName, reason, offendingIds, reasons: event.data['reasons'] },
    }
    await this.emitAlert(alert)
  }

  /** The rule works again — drop its broken-rule card. */
  private async handleRuleRepaired(event: SystemEvent): Promise<void> {
    const ruleId = event.data['ruleId']
    if (typeof ruleId !== 'string' || ruleId.length === 0) return
    const stableId = `nc-rule-broken:${ruleId}`
    try {
      await this.dismiss(stableId)
    } catch (err) {
      this.ctx.logger?.debug(
        'NotificationRuleRepaired: dismiss failed (likely already dismissed)',
        {
          meta: { stableId, error: errMsg(err) },
        },
      )
    }
  }

  /** Stream online after an outage — drop the matching offline card. */
  private async handleStreamOnline(event: SystemEvent): Promise<void> {
    const deviceId = event.data['deviceId']
    if (typeof deviceId !== 'number') return
    const stableId = `stream-offline:${String(deviceId)}`
    await this.dismissLegacyStreamCards(deviceId)
    try {
      await this.dismiss(stableId)
    } catch (err) {
      this.ctx.logger?.debug('StreamOnline: dismiss failed (likely already dismissed)', {
        meta: { stableId, error: errMsg(err) },
      })
    }
  }

  /**
   * Dismiss the pre-D883 per-cam-stream cards (`stream-offline:<deviceId>:<stream>`)
   * of one device, or of every device when none is named. They can never meet
   * their `stream.online` under the per-device id.
   */
  private async dismissLegacyStreamCards(deviceId: number | undefined): Promise<void> {
    try {
      const pattern =
        deviceId === undefined
          ? /^stream-offline:\d+:.+/
          : new RegExp(`^stream-offline:${String(deviceId)}:.+`)
      for (const alert of await this.listAlerts({ limit: 1000 })) {
        if (alert.status === 'active' && pattern.test(alert.id)) await this.dismiss(alert.id)
      }
    } catch (err) {
      this.ctx.logger?.debug('legacy stream cards: sweep failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private async resolveDeviceName(deviceId: number): Promise<string | undefined> {
    try {
      const device = await this.ctx.api.deviceManager.getDevice.query({ deviceId })
      if (device !== null && typeof device.name === 'string' && device.name.trim().length > 0) {
        return device.name.trim()
      }
    } catch (err) {
      this.ctx.logger?.debug('resolveDeviceName failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }
    return undefined
  }

  private buildMessage(category: string, data: Record<string, unknown>, sourceId?: string): string {
    // Addon lifecycle events always carry the addon id in `source.id`;
    // some emit sites (e.g. BaseAddon.updateGlobalSettings) don't also
    // duplicate it into `data.addonId`. Fall back to the event source so
    // the alert names the addon ("stream-broker updated") instead of the
    // bare "unknown" placeholder.
    const addonId = (data.addonId as string | undefined) ?? sourceId
    const device = deviceLabelFromEventData(data)
    const error = data.error as string | undefined
    const processId = data.processId as string | undefined

    switch (category) {
      case 'addon.crashed':
        return `Addon "${addonId ?? 'unknown'}" crashed${error ? `: ${error}` : ''}`
      case 'addon.runner-failed': {
        const runnerId = typeof data.runnerId === 'string' ? data.runnerId : 'unknown'
        const addonIds = Array.isArray(data.addonIds)
          ? data.addonIds.filter((x): x is string => typeof x === 'string').join(', ')
          : ''
        return `Runner "${runnerId}" gave up${addonIds.length > 0 ? ` (addons: ${addonIds})` : ''}`
      }
      case 'addon.error':
        return `Addon "${addonId ?? 'unknown'}" error${error ? `: ${error}` : ''}`
      case 'addon.installed':
        return `Addon "${addonId ?? 'unknown'}" installed`
      case 'addon.updated': {
        const from = data.fromVersion as string | undefined
        const to = data.toVersion as string | undefined
        const pkg =
          typeof data.packageName === 'string' && data.packageName.length > 0
            ? data.packageName
            : (addonId ?? 'unknown')
        return `Addon "${pkg}" updated${from && to ? ` from ${from} to ${to}` : to ? ` to ${to}` : ''}`
      }
      case 'addon.uninstalled':
        return `Addon "${addonId ?? 'unknown'}" uninstalled`
      case 'device.unregistered':
        return `Device "${device}" unregistered`
      case 'agent.offline':
        return `Agent "${(data.agentId as string | undefined) ?? (data.nodeId as string | undefined) ?? 'unknown'}" disconnected${data.reason ? `: ${String(data.reason)}` : ''}`
      case 'backup.restored':
        return `Backup restored${data.source ? ` from ${String(data.source)}` : ''}`
      case 'notification.failed':
        return `Notification failed${error ? `: ${error}` : ''}`
      case 'system.restarting':
        return `System restarting${data.reason ? ` — ${String(data.reason)}` : ''}`
      case 'system.restart-completed': {
        const pkg = typeof data.packageName === 'string' ? data.packageName : undefined
        const to = typeof data.toVersion === 'string' ? data.toVersion : undefined
        const kind = typeof data.kind === 'string' ? data.kind : 'restart'
        if (pkg !== undefined && to !== undefined) return `${pkg} is now ${to}`
        return `Node restart completed (${kind})`
      }
      case 'update.available': {
        const pkg = typeof data.packageName === 'string' ? data.packageName : 'package'
        const latest = typeof data.latestVersion === 'string' ? data.latestVersion : '?'
        const node = typeof data.nodeId === 'string' ? data.nodeId : undefined
        return `${pkg} ${latest} available${node !== undefined ? ` on ${node}` : ''}`
      }
      case 'recording.error':
        return `Recording error on "${device}"${error ? `: ${error}` : ''}`
      case 'recording.storage.critical':
        return `Storage critical for "${device}"`
      case 'system.tls-cert-changed':
        return data.caRotated === true
          ? `TLS certificate reissued (${String(data.reason)}) — the local CA also changed. Re-install ${String(data.caCertPath)} on any device that trusted the old one.`
          : `TLS certificate reissued (${String(data.reason)}) — the local CA is unchanged, previously trusted devices keep working.`
      case 'process.crashed':
        return `Process "${processId ?? 'unknown'}" crashed`
      default:
        return `Event: ${category}`
    }
  }

  // ── Private: persistence ─────────────────────────────────────────

  private async emitAlert(alert: Alert): Promise<void> {
    const existingRaw = await this.readAlertRaw(alert.id)
    const toStore = mergeEmitAlert({
      existing:
        existingRaw === null
          ? null
          : {
              read: existingRaw.read,
              episodeKey: existingRaw.episodeKey,
              status: existingRaw.status,
            },
      incoming: alert,
    })
    const isNew = existingRaw === null
    const stored = await this.persistAlert(toStore)
    if (isNew) this.emitAlertCreatedEvent(stored)
    else this.emitAlertUpdatedEvent(alert.id, stored)
    await this.enforceMaxAlerts()
    await this.enforceRetention()
  }

  private async updateAlert(alertId: string, patch: Partial<Alert>): Promise<void> {
    await this.mergeUpdate(alertId, { ...patch, updatedAt: Date.now() })
    this.emitAlertUpdatedEvent(alertId, patch)
  }

  /**
   * Read-merge-write: SettingsBackend.update() replaces the entire `data` blob,
   * so we must read the existing record, merge the patch, and write back.
   */
  /** Alert writes (stamp + store + announce) from any caller, one at a time. */
  private writeChain: Promise<unknown> = Promise.resolve()

  private serializedWrite<T>(write: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(write, write)
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private mergeUpdate(id: string, patch: Record<string, unknown>): Promise<void> {
    return this.serializedWrite(() => this.mergeUpdateNow(id, patch))
  }

  private async mergeUpdateNow(id: string, patch: Record<string, unknown>): Promise<void> {
    const store = this.alertStore
    if (store === null) return
    const before = await this.readAlertRaw(id)
    const previous = before?.episode ?? null
    // A patch that carries its own `metadata` replaces the stored one: the
    // episode identity must survive it.
    const metadata = patch['metadata']
    const keepEpisode =
      previous !== null && typeof metadata === 'object' && metadata !== null
        ? { metadata: { ...metadata, episodeId: previous.episodeId } }
        : {}
    await store.mergeUpdate(id, { ...patch, ...keepEpisode })
    const after = await store.getData(id)
    const parsed = after === null ? null : AlertSchema.safeParse({ id, ...after })
    if (parsed?.success === true) this.announceEpisode(previous, parsed.data)
  }

  /**
   * Store an alert, stamping its episode identity. The stored alert is what a
   * caller must use afterwards, and the opening or closing of a critical/error
   * episode is announced here, in the one place every write passes through.
   */
  private persistAlert(alert: Alert): Promise<Alert> {
    return this.serializedWrite(() => this.persistAlertNow(alert))
  }

  private async persistAlertNow(alert: Alert): Promise<Alert> {
    const store = this.alertStore
    if (store === null) return alert
    const previous = (await this.readAlertRaw(alert.id))?.episode ?? null
    const episodeId = nextEpisodeId({
      alertId: alert.id,
      previous,
      incomingKey: episodeKeyFromMetadata(alert.metadata),
      now: Date.now(),
    })
    const stamped: Alert = {
      ...alert,
      metadata: { ...alert.metadata, episodeId },
    }
    await store.persist(stamped)
    this.announceEpisode(previous, stamped)
    return stamped
  }

  /**
   * Announce an episode edge on the bus. Telemetry, and it may be dropped
   * (D8): Notification Center reconciles from the alerts store (D11, D49).
   */
  private announceEpisode(previous: EpisodeView | null, alert: Alert): void {
    const edge = episodeEdge(previous, episodeViewOf(alert))
    if (edge === null) return
    this.ctx.eventBus?.emit(
      createEvent(
        EventCategory.AlertEpisode,
        EVENT_SOURCE,
        alertEpisodePayload(alert, edge, Date.now()),
      ),
    )
  }

  private emitAlertCreatedEvent(alert: Alert): void {
    this.ctx.eventBus?.emit(
      createEvent('alert.created', EVENT_SOURCE, {
        id: alert.id,
        category: alert.category,
        severity: alert.severity,
        title: alert.title,
        status: alert.status,
      }),
    )
  }

  private emitAlertUpdatedEvent(alertId: string, patch: Partial<Alert>): void {
    const patchRecord: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) {
      patchRecord[key] = value
    }
    this.ctx.eventBus?.emit(
      createEvent('alert.updated', EVENT_SOURCE, {
        alertId,
        patch: patchRecord,
      }),
    )
  }

  private async enforceMaxAlerts(): Promise<void> {
    const store = this.alertStore
    if (store === null) return

    const total = await store.countAll()
    if (total <= this.config.maxAlerts) return

    const all = await store.listAllByCreatedAtAsc()

    for (const id of selectOverflow(all.map(toPrunable), this.config.maxAlerts)) {
      await store.delete(id)
    }
  }

  private async enforceRetention(): Promise<void> {
    const store = this.alertStore
    if (store === null) return

    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000
    const all = await store.listAllByCreatedAtAsc()

    for (const id of selectExpired(all.map(toPrunable), cutoff)) {
      await store.delete(id)
    }
  }
}

export default AlertCenterAddon
