/**
 * The Loki destinations of one node: one `LokiDestination` per `destinations` record (planning#408).
 *
 * `write` fans out to every one of them; each keeps its own queue, flush timer, counters and
 * client, so one unreachable Loki never delays another. `read` / `describeRead` take an optional
 * `instanceId`; without it the first READABLE instance answers (ordered by record id, so the
 * answer is stable). The set never logs: it is registered as a log destination, and a line it
 * wrote would feed itself. The addon logs around it.
 */
import type {
  ILogDestination,
  LogEntry,
  LogReadCapabilities,
  LogReadQuery,
  LogReadResult,
} from '@camstack/types'
import {
  LokiDestination,
  type LokiConfig,
  type LokiDestinationDeps,
  type LokiStatus,
} from './loki-destination.js'

export interface LokiInstanceStatus extends LokiStatus {
  readonly instanceId: string
}

/** What a read or a capability probe may name. */
export interface LokiInstanceSelector {
  readonly instanceId?: string | undefined
}

const INERT_STATUS: LokiStatus = {
  enabled: false,
  configured: false,
  queued: 0,
  pushed: 0,
  dropped: 0,
  failures: 0,
  lastError: null,
  lastPushAtMs: null,
}

export class LokiDestinationSet implements ILogDestination {
  private readonly members = new Map<string, LokiDestination>()

  constructor(private readonly deps?: LokiDestinationDeps) {}

  async initialize(): Promise<void> {
    // Members are created by `apply`; there is nothing to start on an empty set.
  }

  /** The ids this set currently holds, in record-id order. */
  ids(): readonly string[] {
    return [...this.members.keys()].sort()
  }

  /**
   * Reconcile the set with `configs` (record id to config): add the new, reconfigure the
   * existing, close the ones no longer there. An id in `keep` is left exactly as it is —
   * its config could not be read this time (a locked keychain), so the previous one stands.
   */
  async apply(
    configs: ReadonlyMap<string, LokiConfig>,
    keep: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    for (const [id, member] of [...this.members]) {
      if (configs.has(id) || keep.has(id)) continue
      this.members.delete(id)
      await member.shutdown()
    }
    for (const [id, config] of configs) {
      const existing = this.members.get(id)
      if (existing !== undefined) {
        await existing.reconfigure(config)
        continue
      }
      const member = new LokiDestination(this.deps)
      await member.initialize(config)
      this.members.set(id, member)
    }
  }

  write(entry: LogEntry): void {
    for (const member of this.members.values()) member.write(entry)
  }

  async flush(): Promise<void> {
    await Promise.all([...this.members.values()].map((m) => m.flush()))
  }

  /** The status of one instance; without an id, the first one (an inert status when none). */
  getStatus(instanceId?: string): LokiStatus {
    const id = instanceId ?? this.ids()[0]
    const member = id === undefined ? undefined : this.members.get(id)
    return member?.getStatus() ?? INERT_STATUS
  }

  getStatuses(): readonly LokiInstanceStatus[] {
    return this.ids().map((instanceId) => ({
      instanceId,
      ...(this.members.get(instanceId)?.getStatus() ?? INERT_STATUS),
    }))
  }

  /** The named instance, or the first one that can be read; null when none can. */
  private async readable(selector?: LokiInstanceSelector): Promise<LokiDestination | null> {
    if (selector?.instanceId !== undefined) return this.members.get(selector.instanceId) ?? null
    for (const id of this.ids()) {
      const member = this.members.get(id)
      if (member !== undefined && (await member.describeRead()).readable) return member
    }
    return null
  }

  async describeRead(selector?: LokiInstanceSelector): Promise<LogReadCapabilities> {
    const member = await this.readable(selector)
    if (member !== null) return member.describeRead()
    const reason =
      selector?.instanceId !== undefined
        ? `No Loki destination ${selector.instanceId}`
        : 'Loki is not enabled or has no URL'
    return {
      readable: false,
      reason,
      filters: {
        deviceId: true,
        addonId: true,
        nodeId: true,
        tags: true,
        level: true,
        text: true,
        timeRange: true,
      },
      retentionDays: null,
    }
  }

  async read(query: LogReadQuery): Promise<LogReadResult> {
    const member = await this.readable(query)
    if (member === null) throw new Error('Loki is not enabled or has no URL')
    return member.read(query)
  }

  async cancelRead(input: {
    readonly requestId: string
  }): Promise<{ readonly cancelled: boolean }> {
    for (const member of this.members.values()) {
      if ((await member.cancelRead(input)).cancelled) return { cancelled: true }
    }
    return { cancelled: false }
  }

  async shutdown(): Promise<void> {
    const all = [...this.members.values()]
    this.members.clear()
    await Promise.all(all.map((m) => m.shutdown()))
  }
}
