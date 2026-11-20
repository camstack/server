/**
 * The two pieces of memory a group keeps, both in-process and bounded:
 *  - the delivered-set, keyed by (group, notification, member): an outbox retry of a group send
 *    re-sends only the members that failed, because the ones that landed are remembered here;
 *  - the throttle, keyed by (group, member): at most one delivery per member per window.
 *
 * Neither is durable on purpose: a restart forgets them, which costs one duplicate at worst, never a
 * lost notification.
 */

import { createHash } from 'node:crypto'

const KEY_SEPARATOR = '\u0000'

/** How long a delivered member is remembered: longer than any outbox retry horizon. */
export const DELIVERED_TTL_MS: number = 30 * 60_000

/** The most entries either map holds; the oldest go first. */
export const LEDGER_MAX_ENTRIES: number = 5000

export interface MemberLedgerOptions {
  readonly now: () => number
  readonly ttlMs?: number
  readonly maxEntries?: number
}

export class MemberLedger {
  private readonly delivered = new Map<string, number>()
  private readonly lastSent = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(private readonly options: MemberLedgerOptions) {
    this.ttlMs = options.ttlMs ?? DELIVERED_TTL_MS
    this.maxEntries = options.maxEntries ?? LEDGER_MAX_ENTRIES
  }

  /**
   * The key a retry of one send is recognised by. The rule id (`metadata.ruleId`) is part of it when
   * the notification carries one, so two rules on the same event never share a key. With an event id
   * or tag the key is that id; with neither it is a hash of the content (title, body, device).
   */
  static notificationKey(input: {
    readonly eventId?: string | undefined
    readonly tag?: string | undefined
    readonly title?: string | undefined
    readonly body: string
    readonly deviceId?: number | undefined
    readonly metadata?: Readonly<Record<string, unknown>> | undefined
  }): string {
    const rule = input.metadata?.['ruleId']
    const ruleId = typeof rule === 'string' || typeof rule === 'number' ? String(rule) : ''
    const id = input.eventId ?? input.tag
    if (id !== undefined) return [id, ruleId, input.body].join(KEY_SEPARATOR)
    const hash = createHash('sha256')
      .update(
        [input.title ?? '', input.body, String(input.deviceId ?? ''), ruleId].join(KEY_SEPARATOR),
      )
      .digest('hex')
    return ['content', hash].join(KEY_SEPARATOR)
  }

  wasDelivered(groupId: string, notificationKey: string, memberId: string): boolean {
    this.sweep(this.delivered, this.ttlMs)
    return this.delivered.has(this.deliveredKey(groupId, notificationKey, memberId))
  }

  markDelivered(groupId: string, notificationKey: string, memberId: string): void {
    this.remember(this.delivered, this.deliveredKey(groupId, notificationKey, memberId))
  }

  /** Whether `memberId` already got something inside its throttle window. */
  isThrottled(groupId: string, memberId: string, throttleSec: number | undefined): boolean {
    if (throttleSec === undefined || throttleSec <= 0) return false
    const last = this.lastSent.get(`${groupId}${KEY_SEPARATOR}${memberId}`)
    return last !== undefined && this.options.now() - last < throttleSec * 1000
  }

  markSent(groupId: string, memberId: string): void {
    this.remember(this.lastSent, `${groupId}${KEY_SEPARATOR}${memberId}`)
  }

  /** Forget everything of a deleted group. */
  forgetGroup(groupId: string): void {
    const prefix = `${groupId}${KEY_SEPARATOR}`
    for (const map of [this.delivered, this.lastSent]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key)
    }
  }

  private deliveredKey(groupId: string, notificationKey: string, memberId: string): string {
    return [groupId, notificationKey, memberId].join(KEY_SEPARATOR)
  }

  private remember(map: Map<string, number>, key: string): void {
    map.delete(key)
    map.set(key, this.options.now())
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next()
      if (oldest.done === true) break
      map.delete(oldest.value)
    }
  }

  private sweep(map: Map<string, number>, ttlMs: number): void {
    const cutoff = this.options.now() - ttlMs
    for (const [key, at] of map) {
      if (at >= cutoff) break
      map.delete(key)
    }
  }
}
