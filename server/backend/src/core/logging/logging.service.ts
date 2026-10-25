import { LogManager } from '@camstack/system'
import type { ILogDestination, IScopedLogger, LogLevel, LogTags } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { ConfigService } from '../config/config.service'
import type { EventBusService } from '../events/event-bus.service'

/** Baseline tags every hub-local logger gets, so console output never
 *  falls back to `?` for the agent slot. Hub-local addons already
 *  re-tag with their addonId; this ensures non-addon scopes (core
 *  services like `AddonRegistry`, `StreamProbeService`, `moleculer`)
 *  render as `hub` in the agent column.
 *
 *  `pid` is the hub renderer's own OS pid. Entries forwarded from
 *  forked workers via `$hub.log` carry their own `tags.pid` which
 *  wins over this baseline (right-biased merge in `writeFromWorker`). */
const HUB_BASELINE_TAGS: LogTags = { agentId: 'hub', nodeId: 'hub', pid: process.pid }

/**
 * The destination whose files ARE the hub's log history (D898). Once it has
 * registered — and received the boot replay — the in-memory buffer only has
 * to hold a short tail: the instant first page and the lines the file stream
 * has accepted but not yet flushed.
 */
export const HISTORY_DESTINATION_ADDON_ID = 'winston-logging'

/**
 * The tail, in entries, across every addon. ~2k lines is tens of seconds of a
 * busy hub — enough for the first page and the unflushed window, ~0.6 MB.
 * `eventBus.logTailSize` overrides it.
 */
export const HUB_LOG_TAIL_ENTRIES = 2000

export class LoggingService extends LogManager {
  /**
   * Device-name cache consulted by the formatter when a log line
   * carries `tags.deviceId` but no explicit `deviceName`. Populated
   * by `setDeviceNames` whenever device-manager emits registered /
   * updated / removed events. Missing entries fall back to `#<id>`.
   */
  private readonly deviceNames = new Map<number, string>()

  /** Tail size applied once the history destination registers. */
  private readonly tailEntries: number
  private shrunkToTail = false

  constructor(configService: ConfigService) {
    // The log buffer is now partitioned per addonId (see PartitionedLogBuffer):
    // this value caps EACH addon's bucket, not the total. A chatty addon evicts
    // only its own lines, so quiet addons (e.g. a HomeAssistant `image` entity)
    // keep their sparse history. `eventBus.ringBufferSize` still sizes the
    // separate system-event ring; logs get their own per-addon cap.
    const perAddonCapacity = configService.get<number>('eventBus.perAddonLogBufferSize') ?? 5000
    // Total ceiling across all buckets. Left UNSET here on purpose so the buffer
    // applies its own default (`DEFAULT_MAX_TOTAL_LOG_ENTRIES`): the per-addon
    // rings are a hard bound only per bucket, and their product grows with the
    // roster — hub-main ingests from every local runner AND every agent, so
    // "unbounded by default" meant ~300k retained entries (~92MB) on the one
    // process that must fit inside the cgroup. An operator who genuinely wants
    // no aggregate bound writes an explicit `null`, which is preserved.
    const maxTotalEntries = configService.get<number | null>('eventBus.maxTotalLogBufferSize')
    // Only entries at or below this level are ever discarded to meet the total.
    const pruneLevel = configService.get<LogLevel>('eventBus.logBufferPruneLevel') ?? 'debug'
    super(perAddonCapacity, { maxTotalEntries, pruneLevel })
    this.tailEntries = configService.get<number>('eventBus.logTailSize') ?? HUB_LOG_TAIL_ENTRIES
    // Enriches every emitted LogEntry with `tags.deviceName` before
    // destinations / subscribers see it — works across bundled copies
    // of `@camstack/system` (addon packages) because the mutation
    // happens upstream of their formatters.
    this.setDeviceNameLookup((id) => this.deviceNames.get(id) ?? null)
  }

  /**
   * Adds the destination, and — the first time the HISTORY destination
   * arrives — shrinks the buffer to the tail AFTER its boot replay, so the
   * files start with the first boot line however long the boot was.
   *
   * The tail prunes `info` and below first (the lines are on disk); a live
   * addon's `warn`/`error` still outlive them, and whole idle buckets go
   * last, exactly as the buffer's own policy says.
   */
  override addDestination(
    dest: ILogDestination,
    opts: { replay?: boolean; addonId?: string } = {},
  ): void {
    super.addDestination(dest, opts)
    if (!this.shrunkToTail && opts.addonId === HISTORY_DESTINATION_ADDON_ID) {
      this.shrunkToTail = true
      this.reconfigureBuffer({
        perAddonCapacity: this.tailEntries,
        maxTotalEntries: this.tailEntries,
        pruneLevel: 'info',
      })
    }
  }

  /** Bulk-refresh from device-manager snapshot. Replaces every entry. */
  setDeviceNames(entries: ReadonlyArray<{ id: number; name: string }>): void {
    this.deviceNames.clear()
    for (const { id, name } of entries) {
      if (
        typeof id === 'number' &&
        Number.isFinite(id) &&
        typeof name === 'string' &&
        name.length > 0
      ) {
        this.deviceNames.set(id, name)
      }
    }
  }

  /** Incremental update — called from DeviceRegistered / DeviceUpdated. */
  upsertDeviceName(id: number, name: string | undefined): void {
    if (!Number.isFinite(id)) return
    if (typeof name === 'string' && name.length > 0) this.deviceNames.set(id, name)
    else this.deviceNames.delete(id)
  }

  /** Drop on DeviceRemoved. */
  removeDeviceName(id: number): void {
    this.deviceNames.delete(id)
  }

  /**
   * Subscribe to `device.*` events so the cache stays live: every
   * DeviceRegistered / updated emit carries `{deviceId, name}` — we
   * upsert, and DeviceUnregistered clears. Call once at boot.
   */
  attachDeviceNameStream(eventBus: EventBusService): void {
    const selfLogger = this.createLogger('logging').withTags({ addonId: 'logging' })
    eventBus.subscribe({ category: EventCategory.DeviceRegistered }, (event) => {
      const data = event.data as { deviceId?: number; name?: string } | undefined
      if (data && typeof data.deviceId === 'number') {
        this.upsertDeviceName(data.deviceId, data.name)
        selfLogger.info('device-name cache upserted', {
          meta: {
            deviceId: data.deviceId,
            name: data.name ?? null,
            cacheSize: this.deviceNames.size,
          },
        })
      }
    })
    eventBus.subscribe({ category: EventCategory.DeviceUnregistered }, (event) => {
      const data = event.data as { deviceId?: number } | undefined
      if (data && typeof data.deviceId === 'number') this.removeDeviceName(data.deviceId)
    })
  }

  /**
   * Override — every logger created hub-side comes pre-tagged with
   * `agentId: 'hub'`. Callers that need per-addon identity chain
   * `.withTags({ addonId })` on top (the merge is right-biased, so
   * the explicit tag wins).
   */
  override createLogger(scope?: string): IScopedLogger {
    return super.createLogger(scope).withTags(HUB_BASELINE_TAGS)
  }

  /**
   * Write a log entry received from a forked worker / remote agent.
   * Called by the `$hub.log` action and `log-receiver.ingest` action.
   *
   * Tags propagated by the worker (including `deviceId`, `deviceName`,
   * `integrationId`, `streamId`, etc.) are preserved via `withTags`;
   * baseline tags (`addonId`, `nodeId`, `agentId`) are always ensured
   * even if the worker didn't set them explicitly.
   */
  writeFromWorker(entry: {
    addonId: string
    nodeId?: string
    level: string
    message: string
    scope?: string
    tags?: LogTags
    meta?: Record<string, unknown>
  }): void {
    // Scope is a single optional sub-component label; addon/node identity
    // lives in tags, not in scope. Pass through whatever the worker set.
    let logger = this.createLogger(entry.scope)
    const nodeId = entry.nodeId
    const agentId = nodeId?.includes('/') ? nodeId.split('/')[0]! : nodeId
    // `agentId` is always the EMITTER's slot. `nodeId` is the emitter's only
    // as a default: a caller that logs ABOUT another node
    // (`tags: { nodeId: target }`) keeps its tag, exactly as an in-process
    // logger does — stamping the emitter over it made every
    // `inference device selection` / `auto benchmark:*` line of a forked
    // addon read as `hub/pipeline-orchestrator`.
    const mergedTags: LogTags = {
      ...entry.tags,
      addonId: entry.addonId,
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(typeof entry.tags?.nodeId === 'string' ? { nodeId: entry.tags.nodeId } : {}),
    }
    logger = logger.withTags(mergedTags)
    const level = entry.level as 'info' | 'warn' | 'error' | 'debug'
    const extras = entry.meta !== undefined ? { meta: entry.meta } : undefined
    if (typeof logger[level] === 'function') {
      logger[level](entry.message, extras)
    } else {
      logger.info(entry.message, extras)
    }
  }
}
