/**
 * The STATE SUMMARY, assembled (D647): the system-state ledger, the send
 * stamps, the scheduler and the preview — behind a few narrow ports, so the
 * notification centre only wires closures and the whole feature is testable
 * without it.
 */
import type { IScopedLogger, NcRule, NcRuleInput, NcStateSummaryPreview } from '@camstack/types'
import type { DurableKindDeps } from '../../durable/durable-wiring.js'
import { systemEventSummarySplitOf } from '@camstack/types'
import type { NcOpenAlert } from '../alerts/open-alert.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import { updatePackages } from '../event-intake.js'
import type { NcLivenessRow } from '../liveness-ledger.js'
import type { NcRuleSubject, NcSystemEventSubject } from '../rule-engine.js'
import type { NcTextCatalog } from '../text-catalog.js'
import type { ClosedWindow } from '../timelapse/window-bounds.js'
import type { AddonUpdateComplete } from '../update-complete-coalescer.js'
import { type NcRunnerStateReads, readRunningRunners } from './runner-recovery.js'
import { type NcNodeView, stateSources } from './state-sources.js'
import {
  collectStateSummary,
  isEmptyStateSummary,
  type NcStateSummary,
  type NcStateSummaryText,
  stateSummaryText,
} from './state-summary.js'
import {
  stateSummarySectionOf,
  stateSummarySubjects,
  stateSummaryTestRecordId,
} from './state-summary-delivery.js'
import {
  NcStateSummaryScheduler,
  type NcStateSummaryTickReport,
} from './state-summary-scheduler.js'
import { NcStateSummaryStampStore } from './state-summary-stamps.js'
import type { NcStateSummaryTest } from './state-summary-test.js'
import {
  HUB_NODE,
  isUpdateTarget,
  NcSystemStateLedger,
  NcSystemStateStore,
  type NcUpdateList,
} from './system-state-ledger.js'

export interface NcStateSummaryServiceDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  /** Every ENABLED `system-event` rule. */
  readonly rules: () => readonly NcRule[]
  readonly alerts: () => readonly NcOpenAlert[] | null
  readonly liveness: () => readonly NcLivenessRow[] | null
  readonly lookup: (deviceId: number) => NcDeviceIdentity | undefined
  /** Has the device directory answered once (`NcDeviceDirectory.isWarm`)? */
  readonly devicesAnswered: () => boolean
  /**
   * The node directory (`nodes.directory`, the cheap registry-plus-history
   * list — never `nodes.topology`, D315). Read once per summary: the D8
   * reconcile. Absent = never answered, and the node sections say so.
   */
  readonly readNodes?: () => Promise<NcNodeDirectoryAnswer>
  /**
   * The runner state (D708): is a crash-looped runner running again? Read once
   * per summary; only a positive answer closes a crash-loop row. Absent = the
   * rows close only on their events, as before.
   */
  readonly readRunners?: NcRunnerStateReads
  readonly livenessHoldoffMs: number
  readonly isMuted: (deviceId: number) => boolean
  readonly texts: () => NcTextCatalog
  /** Build the rule's outbox rows for this subject and enqueue them. */
  readonly enqueue: (
    rule: NcRule,
    subject: NcRuleSubject,
    origin: NcStateSummaryOrigin,
  ) => Promise<NcStateSummaryEnqueued>
}

/**
 * Whose row it is: a scheduled window (`system`), or a TEST an operator
 * pressed (`synthetic` — the outbox and the notification mark it as a test,
 * exactly like every other rule test, review M5).
 */
export type NcStateSummaryOrigin = 'system' | 'synthetic'

/** What one enqueue did: the rows inserted and the targets they address. */
export interface NcStateSummaryEnqueued {
  readonly inserted: number
  readonly targetIds: readonly string[]
}

/** What `nodes.directory` answers, as far as the summary reads it. */
export interface NcNodeDirectoryAnswer {
  readonly nodes: readonly {
    readonly id: string
    readonly isOnline: boolean
    /** The heading of a per-node section (D708); the id when absent. */
    readonly name?: string
    readonly isHub?: boolean
  }[]
  readonly complete: boolean
}

function stringOf(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The full list an `update.available` event carries, and the nodes it speaks
 * for: every node a row names, plus the event's own `nodeId`. The emitter
 * never sends an empty list (it emits only when a `latestVersion` changes), so
 * the empty case is defensive, not a path that clears anything today — see
 * {@link NcUpdateList} for the limit that leaves.
 */
export function updateListOf(data: Readonly<Record<string, unknown>>): NcUpdateList | null {
  const target = data['target']
  if (!isUpdateTarget(target)) return null
  const rows = updatePackages(data)
  const eventNode = stringOf(data, 'nodeId')
  const nodes = new Set(rows.map((row) => row.nodeId ?? eventNode ?? HUB_NODE))
  if (eventNode !== undefined) nodes.add(eventNode)
  const withNode = rows.map((row) =>
    row.nodeId === undefined && eventNode !== undefined ? { ...row, nodeId: eventNode } : row,
  )
  return { target, nodeIds: [...nodes], rows: withNode }
}

export class NcStateSummaryService {
  private readonly stateStore: NcSystemStateStore
  private readonly stampStore: NcStateSummaryStampStore
  readonly ledger: NcSystemStateLedger
  private readonly scheduler: NcStateSummaryScheduler

  /** Drop a deleted device's mirrored state rows (D871). */
  evictDevice(deviceId: number): number {
    return this.stateStore.evictDevice(deviceId)
  }

  constructor(private readonly deps: NcStateSummaryServiceDeps) {
    this.stateStore = new NcSystemStateStore({ records: deps.records, logger: deps.logger })
    this.stampStore = new NcStateSummaryStampStore({ records: deps.records, logger: deps.logger })
    this.ledger = new NcSystemStateLedger({ rows: this.stateStore.port(), logger: deps.logger })
    this.scheduler = new NcStateSummaryScheduler({
      rules: deps.rules,
      stamps: this.stampStore.port(),
      collect: (rule, nowMs) => this.collect(rule, nowMs),
      deliver: (rule, summary, window) => this.deliver(rule, summary, window),
      now: deps.now,
      logger: deps.logger,
    })
  }

  /** Boot back-fill. Each load that fails leaves its mirror unanswered — the summary then says so. */
  async load(): Promise<{ readonly states: number; readonly stamps: number }> {
    const states = await this.stateStore.load()
    const stamps = await this.stampStore.load()
    return { states, stamps }
  }

  /** One system subject the intake accepted. */
  observeSystem(system: NcSystemEventSubject, atMs: number): void {
    this.ledger.observe(system, atMs)
  }

  /**
   * The RAW bus event, before the intake's gates (D647 review I1/I3/I5): the
   * facts that close or replace a state even when no notification is owed —
   * any `stream.online`, the full `update.available` list of a node, an addon
   * that started, a camera the balancer placed.
   */
  observeRawEvent(
    category: string,
    data: Readonly<Record<string, unknown>>,
    atMs: number,
    sourceNodeId?: string,
  ): void {
    switch (category) {
      case 'stream.online': {
        const deviceId = data['deviceId']
        if (typeof deviceId === 'number') this.ledger.observeStreamOnline(deviceId)
        return
      }
      case 'update.available': {
        const list = updateListOf(data)
        if (list !== null) this.ledger.observeUpdateList(list, atMs)
        return
      }
      case 'addon.started':
      case 'addon.restarted': {
        const addonId = stringOf(data, 'addonId')
        // The NODE is the event's `source.nodeId` — the broker node id a
        // crash-loop row carries. `data.agent` is the agent's display NAME
        // (`CAMSTACK_AGENT_NAME ?? 'hub'`) and never matched on an agent. An
        // in-process `addon.started` names no node: it is THIS process's
        // node, the hub (the centre evaluates only there), and only the hub's
        // rows are closed by it.
        if (addonId !== undefined) {
          this.ledger.observeAddonStarted(addonId, sourceNodeId ?? HUB_NODE)
        }
        return
      }
      case 'pipeline.camera-assigned': {
        const nodeId = stringOf(data, 'agentNodeId')
        const placed = data['pinned'] === false && data['reason'] !== 'unassigned'
        if (nodeId !== undefined && placed) this.ledger.observeCameraPlaced(nodeId)
        return
      }
      default:
        return
    }
  }

  observeDetection(deviceId: number): void {
    this.ledger.observeDetection(deviceId)
  }

  observeAddonUpdated(update: AddonUpdateComplete): void {
    this.ledger.observeAddonUpdated(update)
  }

  tick(): Promise<NcStateSummaryTickReport> {
    return this.scheduler.tick()
  }

  /** The summary this rule would send NOW (`previewStateSummary`) — sends nothing, stamps nothing. */
  async preview(rule: NcRule | NcRuleInput): Promise<NcStateSummaryPreview> {
    const nowMs = this.deps.now()
    const summary = await this.collect(rule, nowMs)
    const text = this.word(summary, nowMs)
    const split = systemEventSummarySplitOf(rule)
    const empty = isEmptyStateSummary(summary)
    // What would be SENT (D698): one row, or one per section with something to
    // say — nothing at all when there is nothing to report.
    const rows = empty
      ? []
      : split === 'section'
        ? text.sections.map((section) => ({
            section: section.id,
            title: section.title,
            text: section.body,
            count: section.count,
          }))
        : [
            {
              title: text.sections.map((section) => section.title).join(', '),
              text: text.text,
              count: text.count,
            },
          ]
    return {
      empty,
      split,
      rows,
      count: text.count,
      text: text.text,
      sections: summary.sections.map((section) => ({
        id: section.id,
        status: section.status,
        items: section.items.length,
        ...(section.reason !== undefined ? { reason: section.reason } : {}),
      })),
      dropped: { ...summary.dropped },
      excludedGroups: [...summary.excludedGroups],
    }
  }

  /**
   * TEST the rule (D698, `nc.testRule`): the summary it would send NOW,
   * ENQUEUED through the ordinary outbox under a test record id — split as the
   * rule is. The per-camera mute is bypassed, as every rule test bypasses it,
   * and a summary has no cooldown to bypass. Nothing to report sends nothing
   * and SAYS so, per section.
   */
  async test(rule: NcRule): Promise<NcStateSummaryTest> {
    const nowMs = this.deps.now()
    const summary = await this.collect(rule, nowMs, () => false)
    const split = systemEventSummarySplitOf(rule)
    const recordId = stateSummaryTestRecordId(rule.id, nowMs)
    const sections = summary.sections.map((section) => ({
      id: section.id,
      status: section.status,
      items: section.items.length,
      ...(section.reason !== undefined ? { reason: section.reason } : {}),
    }))
    const meta = { ruleId: rule.id, rule: rule.name, split, bypassMute: true }
    if (isEmptyStateSummary(summary)) {
      this.deps.logger.info('state summary TEST has nothing to report — not sent', {
        meta: { ...meta, dropped: summary.dropped },
      })
      return { recordId, split, nothingToReport: true, sections, rows: [] }
    }
    const text = this.word(summary, nowMs)
    const subjects = stateSummarySubjects({
      rule,
      summary,
      text,
      window: { startMs: nowMs, endMs: nowMs },
      split,
      recordBase: recordId,
    })
    const rows: NcStateSummaryTest['rows'][number][] = []
    for (const subject of subjects) {
      const enqueued = await this.deps.enqueue(rule, subject, 'synthetic')
      const section = stateSummarySectionOf(subject)
      rows.push({
        recordId: subject.recordId,
        ...(section !== undefined ? { section } : {}),
        enqueued: enqueued.inserted,
        targetIds: [...enqueued.targetIds],
      })
    }
    this.deps.logger.info('state summary TEST enqueued', {
      meta: {
        ...meta,
        items: summary.itemCount,
        rows: rows.map((row) => `${row.recordId}:${String(row.enqueued)}`),
      },
    })
    return { recordId, split, nothingToReport: false, sections, rows }
  }

  private async collect(
    rule: NcRule | NcRuleInput,
    nowMs: number,
    isMuted: (deviceId: number) => boolean = this.deps.isMuted,
  ): Promise<NcStateSummary> {
    const nodes = await this.nodeView()
    await this.reconcileCrashLoops()
    return collectStateSummary({
      rule,
      nowMs,
      isMuted,
      sources: stateSources({
        alerts: this.deps.alerts,
        liveness: this.deps.liveness,
        state: () => this.ledger.openRows(),
        lookup: this.deps.lookup,
        devicesAnswered: this.deps.devicesAnswered,
        nodes,
        livenessHoldoffMs: this.deps.livenessHoldoffMs,
      }),
    })
  }

  /**
   * Close every crash-loop row whose runner the runner state says is RUNNING
   * (D708). A preview runs it too: it corrects the ledger's memory, it sends
   * and stamps nothing. A read that fails closes nothing and is logged.
   */
  private async reconcileCrashLoops(): Promise<void> {
    const reads = this.deps.readRunners
    if (reads === undefined) return
    const runners = this.ledger.crashLoopRunners()
    if (runners.length === 0) return
    const answer = await readRunningRunners(reads, runners)
    if (answer.failed.length > 0) {
      this.deps.logger.warn(
        'state summary: the runner state did not answer — crash-looped runners it covers stay reported',
        { meta: { failed: answer.failed, runners: runners.map((runner) => runner.key) } },
      )
    }
    for (const runner of runners) {
      if (!answer.running.has(runner.key)) continue
      this.deps.logger.info(
        'state summary: a crash-looped runner is running again — state closed',
        {
          meta: { key: runner.key, nodeId: runner.nodeId, runnerId: runner.runnerId },
        },
      )
      this.ledger.observeRunnerRunning(runner)
    }
  }

  /** The node directory for one summary, or `null` (logged) when it did not answer. */
  private async nodeView(): Promise<NcNodeView | null> {
    const read = this.deps.readNodes
    if (read === undefined) return null
    try {
      const answer = await read()
      const byId = new Map(answer.nodes.map((node) => [node.id, node]))
      return {
        complete: answer.complete,
        online: (nodeId) => byId.get(nodeId)?.isOnline,
        describe: (nodeId) => {
          const node = byId.get(nodeId)
          if (node === undefined) return undefined
          return { name: node.name ?? node.id, isHub: node.isHub ?? false }
        },
      }
    } catch (err) {
      this.deps.logger.warn(
        'state summary: the node directory did not answer — node sections unavailable',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
      return null
    }
  }

  private word(summary: NcStateSummary, nowMs: number): NcStateSummaryText {
    return stateSummaryText({ texts: this.deps.texts(), summary, nowMs })
  }

  private async deliver(
    rule: NcRule,
    summary: NcStateSummary,
    window: ClosedWindow,
  ): Promise<number> {
    // The window's END is the moment the summary speaks for: "since" is
    // measured from it, like every other word of the row.
    const text = this.word(summary, window.endMs)
    const subjects = stateSummarySubjects({
      rule,
      summary,
      text,
      window,
      split: systemEventSummarySplitOf(rule),
    })
    if (subjects.length === 0) {
      this.deps.logger.warn('state summary produced no row — not sent', {
        meta: { ruleId: rule.id, sections: text.sections.length },
      })
      return 0
    }
    let inserted = 0
    for (const subject of subjects) {
      inserted += (await this.deps.enqueue(rule, subject, 'system')).inserted
    }
    return inserted
  }
}
