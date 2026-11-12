/**
 * Hold a rule's deliveries for a few seconds and send one summary when several
 * land in that window (operator, 2026-11-12).
 *
 * The window is per (rule, target). It opens on the first delivery and flushes
 * at first + N seconds — the fixed mode of {@link WindowCoalescer}, the same
 * mechanism the addon-update batch uses in its sliding mode. One item in the
 * window is sent unchanged, only late. Two or more become one state-summary
 * notification, and each held row stays in history as sent, pointing at it.
 *
 * Durability: the rows are written to the outbox immediately, marked held, and
 * the drain will not send them while the mark is there. A restart reloads the
 * pending rows and finishes the window. A stop flushes what is still open, so
 * a shutdown does not wait out the clock. Nothing here gates on a fallible
 * read (D49): the pending map the outbox already holds is the whole input.
 */

import { groupWithinSecOf, type NcRule } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import { groupWindowSubject } from './group-window-summary.js'
import type { NcOutbox, NcOutboxEnqueueInput, NcOutboxEntry } from './outbox.js'
import { outboxEntryId } from './outbox-key.js'
import type { NcRuleSubject } from './rule-engine.js'
import type { NcRuleStore } from './rule-store.js'
import type { NcTextCatalog } from './text-catalog.js'
import { WindowCoalescer } from './window-coalescer.js'

function isHeld(entry: NcOutboxEntry | undefined): entry is NcOutboxEntry {
  return entry !== undefined && entry.payload.groupHold !== undefined
}

const MS_PER_SEC = 1000

export interface NcDeliveryGroupWindowDeps {
  readonly now: () => number
  readonly logger: IScopedLogger
  readonly outbox: NcOutbox
  readonly rules: NcRuleStore
  readonly texts: NcTextCatalog
  readonly isMuted: (deviceId: number) => boolean
  /** Write the one summary row and return the inputs, so the id can be named. */
  readonly enqueueSummary: (
    rule: NcRule,
    subject: NcRuleSubject,
    targetId: string,
  ) => Promise<readonly NcOutboxEnqueueInput[]>
  /** Load snoozes and drain. Used when a timer flushes between drain ticks. */
  readonly deliverReady: () => Promise<void>
}

export function groupWindowKey(ruleId: string, targetId: string): string {
  return `${ruleId}\u0000${targetId}`
}

export class NcDeliveryGroupWindow {
  private readonly coalescer: WindowCoalescer<string>
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: NcDeliveryGroupWindowDeps) {
    this.coalescer = new WindowCoalescer<string>({
      mode: 'fixed',
      delayMs: MS_PER_SEC,
      onFlush: (key, ids) => {
        this.chain = this.chain.then(() => this.flushAndDeliver(key, ids))
      },
      now: deps.now,
    })
  }

  /** Stamp a hold on copies of the entries a matched rule is about to enqueue. */
  hold(rule: NcRule, entries: readonly NcOutboxEnqueueInput[]): readonly NcOutboxEnqueueInput[] {
    const seconds = groupWithinSecOf(rule)
    if (seconds <= 0 || entries.length === 0) return entries
    return entries.map((entry) => this.stamp(rule, entry, seconds * MS_PER_SEC))
  }

  /**
   * Re-arm windows for rows a restart found still pending. Already-due windows
   * flush here; the rest wait out the remainder of their original deadline.
   */
  async recover(entries: readonly NcOutboxEntry[]): Promise<void> {
    for (const entry of entries) {
      const hold = entry.payload.groupHold
      if (hold === undefined || entry.status !== 'pending') continue
      this.coalescer.adopt(hold.key, entry.id, hold.openedAt, hold.releaseAt)
    }
    await this.flushDue()
  }

  /** Flush every window whose deadline `now` has reached, then any timer flush still running. */
  async flushDue(): Promise<void> {
    const due = this.coalescer.takeDue(this.deps.now())
    for (const batch of due) {
      this.chain = this.chain.then(() => this.flush(batch.key, batch.items))
    }
    await this.chain
  }

  /** A stop: send what is open now, rather than waiting for the clock. */
  async flushAll(): Promise<void> {
    const open = this.coalescer.takeAll()
    for (const batch of open) {
      this.chain = this.chain.then(() => this.flush(batch.key, batch.items))
    }
    await this.chain
  }

  /** Drop the timers and the in-memory buckets. Held rows stay in the outbox. A crash. */
  abandon(): void {
    this.coalescer.dispose()
  }

  private stamp(rule: NcRule, entry: NcOutboxEnqueueInput, delayMs: number): NcOutboxEnqueueInput {
    const key = groupWindowKey(rule.id, entry.targetId)
    const slot = this.coalescer.observe(key, outboxEntryId(entry), delayMs)
    this.deps.logger.info('group window holding a delivery', {
      tags: { deviceId: entry.deviceId },
      meta: {
        ruleId: rule.id,
        targetId: entry.targetId,
        recordId: entry.recordId,
        openedAt: slot.openedAt,
        releaseAt: slot.releaseAt,
      },
    })
    return {
      ...entry,
      payload: {
        ...entry.payload,
        groupHold: { key, openedAt: slot.openedAt, releaseAt: slot.releaseAt },
      },
    }
  }

  private async flushAndDeliver(key: string, ids: readonly string[]): Promise<void> {
    await this.flush(key, ids)
    try {
      await this.deps.deliverReady()
    } catch (err) {
      this.deps.logger.warn('group window flush could not deliver', {
        meta: { key, error: String(err) },
      })
    }
  }

  private async flush(key: string, ids: readonly string[]): Promise<void> {
    try {
      await this.flushHeld(key, ids)
    } catch (err) {
      this.deps.logger.warn('group window flush failed — releasing what is still held', {
        meta: { key, error: String(err) },
      })
      for (const id of ids) await this.deps.outbox.releaseGroupHold(id)
    }
  }

  private async flushHeld(key: string, ids: readonly string[]): Promise<void> {
    const pending = ids.map((id) => this.deps.outbox.getPending(id)).filter(isHeld)
    const audible: NcOutboxEntry[] = []
    for (const entry of pending) {
      if (this.deps.isMuted(entry.deviceId)) {
        this.deps.logger.info('group window left a muted device out', {
          tags: { deviceId: entry.deviceId },
          meta: { ruleId: entry.ruleId, targetId: entry.targetId, recordId: entry.recordId, key },
        })
        await this.deps.outbox.dropHeld(entry.id, 'muted')
        continue
      }
      audible.push(entry)
    }
    if (audible.length === 0) return
    const only = audible[0]
    if (audible.length === 1 && only !== undefined) {
      await this.releaseOne(only, key)
      return
    }
    await this.summarise(audible, key)
  }

  private async releaseOne(entry: NcOutboxEntry, key: string): Promise<void> {
    this.deps.logger.info('group window releasing a single delivery', {
      tags: { deviceId: entry.deviceId },
      meta: { ruleId: entry.ruleId, targetId: entry.targetId, recordId: entry.recordId, key },
    })
    await this.deps.outbox.releaseGroupHold(entry.id)
  }

  private async summarise(entries: readonly NcOutboxEntry[], key: string): Promise<void> {
    const first = entries[0]
    if (first === undefined) return
    const rule = this.deps.rules.get(first.ruleId)
    if (rule === null) {
      for (const entry of entries) await this.releaseOne(entry, key)
      return
    }
    const openedAt = first.payload.groupHold?.openedAt ?? this.deps.now()
    const subject = groupWindowSubject({
      rule,
      entries,
      texts: this.deps.texts,
      nowMs: this.deps.now(),
      openedAt,
      targetId: first.targetId,
    })
    if (subject === null) {
      for (const entry of entries) await this.releaseOne(entry, key)
      return
    }
    const inputs = await this.deps.enqueueSummary(rule, subject, first.targetId)
    const summary = inputs[0]
    if (summary === undefined) {
      for (const entry of entries) await this.releaseOne(entry, key)
      return
    }
    const summaryId = outboxEntryId(summary)
    for (const entry of entries) {
      this.deps.logger.info('group window folded a delivery into one summary', {
        tags: { deviceId: entry.deviceId },
        meta: {
          ruleId: entry.ruleId,
          targetId: entry.targetId,
          recordId: entry.recordId,
          summaryId,
          key,
        },
      })
      await this.deps.outbox.settleGrouped(entry.id, summaryId)
    }
  }
}
