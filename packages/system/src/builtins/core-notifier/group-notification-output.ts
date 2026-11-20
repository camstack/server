/**
 * The `notification-output` provider of the `group` kind: a send to a group is one send per member.
 *
 * Both senders reach a group with no change, because both address a target by `(addonId, targetId)`
 * read from the instances of `notification-output`: the notification center's `resolveTarget` and the
 * automation `sendToExportedTarget`. The group only has to be one of those instances.
 *
 * Rules: fan-out goes through `ctx.api.notificationOutput.send` (the `sendToMember` port); a member
 * that is itself a group is refused (`nested-group`); every skip is logged with its reason and the
 * group's tags (D391); a retry re-sends only the members that failed (the ledger).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type AlarmState,
  clampToCaps,
  decideMember,
  errMsg,
  type GroupMember,
  type GroupSkipReason,
  groupMembersOf,
  type INotificationOutputProvider,
  type IScopedLogger,
  type Notification,
  NOTIFIER_GROUP_KIND,
  type NotificationTargetRef,
  type NotificationTargetStore,
  type SendResult,
  shapeForMember,
  type Target,
  type TargetKind,
  type TargetKindCaps,
  unionTargetKindCaps,
} from '@camstack/types'
import { groupTargetKind } from './group-descriptor.js'
import { MemberLedger } from './member-ledger.js'

interface CapsSnapshot {
  readonly at: number
  readonly union: TargetKindCaps
  readonly byKind: ReadonlyMap<string, TargetKindCaps>
}

/** What the group's own re-entrant catalogue answer carries; the reader discards that row. */
const UNREAD_CAPS: TargetKindCaps = unionTargetKindCaps([])

/** How long the union of the members' caps is reused before it is read again. */
const CAPS_TTL_MS = 30_000

/** A target kind and what it delivers. */
export interface MemberKindCaps {
  readonly kind: string
  readonly caps: TargetKindCaps
}

/** What happened to one member of one send. */
export type MemberOutcome =
  | { readonly targetId: string; readonly status: 'sent' }
  | {
      readonly targetId: string
      readonly status: 'skipped'
      readonly reason: GroupSkipReason
    }
  | {
      readonly targetId: string
      readonly status: 'failed'
      readonly error: string
    }

/** What a send to a group did, member by member. */
export interface GroupDeliveryReport {
  readonly groupId: string
  readonly outcomes: readonly MemberOutcome[]
}

export interface GroupNotificationOutputDeps {
  readonly store: Pick<NotificationTargetStore, 'list' | 'getById'>
  /** Every notification target, groups included; `unreadable` names a holder that could not answer. */
  readonly listTargets: () => Promise<{
    readonly targets: readonly NotificationTargetRef[]
    readonly unreadable: readonly {
      readonly addonId: string
      readonly error: string
    }[]
  }>
  /** The kind catalogue of the OTHER providers (the group's own is never asked: it would recurse). */
  readonly listMemberKinds: () => Promise<readonly MemberKindCaps[]>
  readonly sendToMember: (input: {
    readonly addonId: string
    readonly targetId: string
    readonly notification: Notification
  }) => Promise<SendResult>
  /** The alarm panel's state; `null` = it could not be read. */
  readonly readAlarmState: (deviceId: number) => Promise<AlarmState | null>
  readonly ledger: MemberLedger
  readonly now: () => number
  readonly logger: IScopedLogger
}

const CANNED: Notification = {
  title: 'CamStack',
  body: 'This is a CamStack test notification.',
  format: 'text',
  priority: 3,
}

function summary(outcomes: readonly MemberOutcome[]): string {
  const failed = outcomes.flatMap((o) =>
    o.status === 'failed' ? [`${o.targetId}: ${o.error}`] : [],
  )
  return `group delivery failed for ${failed.length} of ${outcomes.length} members (${failed.join('; ')})`
}

export function createGroupNotificationOutputProvider(deps: GroupNotificationOutputDeps): {
  readonly provider: INotificationOutputProvider
  readonly deliver: (group: Target, notification: Notification) => Promise<GroupDeliveryReport>
  /** The ids of the groups as last read, for the sync save-time nested-group check. */
  readonly knownGroupIds: () => ReadonlySet<string>
} {
  const { logger } = deps
  let groupIds: ReadonlySet<string> = new Set()
  let snapshot: CapsSnapshot | null = null
  let inFlight: Promise<CapsSnapshot> | null = null
  // Marks the async chain of a catalogue read. That read fans out to every provider, this one
  // included; the group's own answer is dropped at the source (`readMemberKinds`), so the re-entrant
  // call must answer without waiting on the read it is part of.
  const reading = new AsyncLocalStorage<true>()

  async function compute(): Promise<CapsSnapshot> {
    const [stored, read, kinds] = await Promise.all([
      deps.store.list(),
      deps.listTargets(),
      deps.listMemberKinds(),
    ])
    groupIds = new Set(stored.map((group) => group.id))
    const kindOfTarget = new Map(read.targets.map((target) => [target.id, target.kind]))
    const memberKinds = new Set(
      stored.flatMap((group) =>
        groupMembersOf(group.config).members.flatMap((member) => {
          const kind = kindOfTarget.get(member.targetId)
          return kind === undefined || kind === NOTIFIER_GROUP_KIND ? [] : [kind]
        }),
      ),
    )
    return {
      at: deps.now(),
      union: unionTargetKindCaps(
        kinds.filter((kind) => memberKinds.has(kind.kind)).map((kind) => kind.caps),
      ),
      byKind: new Map(kinds.map((kind) => [kind.kind, kind.caps])),
    }
  }

  /**
   * The union and the per-kind caps, shared: concurrent callers await ONE computation. A failed read
   * caches nothing; the last good snapshot is served when there is one, otherwise the failure
   * propagates (an unread catalogue is never presented as an empty one).
   */
  async function capsSnapshot(): Promise<CapsSnapshot> {
    if (snapshot !== null && deps.now() - snapshot.at < CAPS_TTL_MS) return snapshot
    if (inFlight !== null) return inFlight
    const run = reading
      .run(true, compute)
      .then((fresh) => {
        snapshot = fresh
        return fresh
      })
      .catch((err: unknown) => {
        if (snapshot === null) throw err
        logger.warn('group caps could not be read; serving the last good ones', {
          meta: { error: errMsg(err) },
        })
        return snapshot
      })
      .finally(() => {
        inFlight = null
      })
    inFlight = run
    return run
  }

  async function deliverMember(
    group: Target,
    member: GroupMember,
    notification: Notification,
    notificationKey: string,
    targets: ReadonlyMap<string, NotificationTargetRef>,
    unreadableHolders: readonly string[],
    byKind: ReadonlyMap<string, TargetKindCaps>,
  ): Promise<MemberOutcome> {
    const tags = {
      groupId: group.id,
      ...(notification.deviceId !== undefined ? { deviceId: notification.deviceId } : {}),
    }
    const skip = (reason: GroupSkipReason): MemberOutcome => {
      logger.info('group member skipped', {
        tags,
        meta: { groupId: group.id, targetId: member.targetId, reason },
      })
      return { targetId: member.targetId, status: 'skipped', reason }
    }
    const target = targets.get(member.targetId)
    if (target === undefined) {
      // Only a COMPLETE read may call a target unknown: a holder that could not answer may hold it
      // (D49), so the member FAILS and the outbox retries it.
      if (unreadableHolders.length > 0) {
        const error = `target not found, and these holders could not be read: ${unreadableHolders.join(', ')}`
        logger.warn('group member failed: target not found on a partial read', {
          tags,
          meta: { groupId: group.id, targetId: member.targetId, unreadableHolders },
        })
        return { targetId: member.targetId, status: 'failed', error }
      }
      logger.warn('group member skipped: target not found', {
        tags,
        meta: { groupId: group.id, targetId: member.targetId, reason: 'unknown-target' },
      })
      return { targetId: member.targetId, status: 'skipped', reason: 'unknown-target' }
    }
    if (target.kind === NOTIFIER_GROUP_KIND) return skip('nested-group')
    if (!target.enabled) return skip('target-disabled')
    if (deps.ledger.wasDelivered(group.id, notificationKey, member.targetId)) {
      return skip('already-delivered')
    }
    const alarm =
      member.when?.kind === 'alarm' ? await deps.readAlarmState(member.when.deviceId) : undefined
    const decision = decideMember({
      member,
      notification,
      nowMs: deps.now(),
      ...(alarm !== undefined ? { alarmState: alarm } : {}),
    })
    if (!decision.send) return skip(decision.reason)
    if (deps.ledger.isThrottled(group.id, member.targetId, member.throttleSec)) {
      return skip('throttled')
    }
    const shaped = shapeForMember(member, notification)
    const ownCaps = byKind.get(target.kind)
    try {
      const result = await deps.sendToMember({
        addonId: target.addonId,
        targetId: member.targetId,
        notification: ownCaps === undefined ? shaped : clampToCaps(shaped, ownCaps),
      })
      if (!result.success) {
        const error = result.error ?? 'send failed'
        logger.warn('group member delivery failed', {
          tags,
          meta: { groupId: group.id, targetId: member.targetId, error },
        })
        return { targetId: member.targetId, status: 'failed', error }
      }
      deps.ledger.markDelivered(group.id, notificationKey, member.targetId)
      deps.ledger.markSent(group.id, member.targetId)
      return { targetId: member.targetId, status: 'sent' }
    } catch (err) {
      const error = errMsg(err)
      logger.warn('group member delivery threw', {
        tags,
        meta: { groupId: group.id, targetId: member.targetId, error },
      })
      return { targetId: member.targetId, status: 'failed', error }
    }
  }

  async function deliver(group: Target, notification: Notification): Promise<GroupDeliveryReport> {
    const { members, invalid } = groupMembersOf(group.config)
    if (invalid > 0) {
      logger.warn('group has member rows that could not be read; they are not delivered to', {
        tags: { groupId: group.id },
        meta: { groupId: group.id, invalid },
      })
    }
    const read = await deps.listTargets()
    const targets = new Map(read.targets.map((target) => [target.id, target]))
    const unreadableHolders = read.unreadable.map((holder) => holder.addonId)
    const key = MemberLedger.notificationKey(notification)
    const byKind = await capsSnapshot()
      .then((caps) => caps.byKind)
      .catch((err: unknown): ReadonlyMap<string, TargetKindCaps> => {
        logger.warn('member kind caps could not be read; members degrade on their own', {
          tags: { groupId: group.id },
          meta: { error: errMsg(err) },
        })
        return new Map()
      })
    const outcomes: MemberOutcome[] = []
    for (const member of members) {
      outcomes.push(
        await deliverMember(group, member, notification, key, targets, unreadableHolders, byKind),
      )
    }
    return { groupId: group.id, outcomes }
  }

  async function sendTo(
    group: Target | null,
    id: string,
    notification: Notification,
  ): Promise<SendResult> {
    if (group === null) return { success: false, error: `Unknown target '${id}'` }
    const report = await deliver(group, notification)
    const failed = report.outcomes.some((outcome) => outcome.status === 'failed')
    return failed ? { success: false, error: summary(report.outcomes) } : { success: true }
  }

  const provider: INotificationOutputProvider = {
    listTargetKinds: async (): Promise<TargetKind[]> => {
      if (reading.getStore() === true) return [groupTargetKind(snapshot?.union ?? UNREAD_CAPS)]
      return [groupTargetKind((await capsSnapshot()).union)]
    },
    discoverTargets: async () => [],
    probeTargetConfig: async ({ kind }) => ({
      ok: false,
      resolvedUrl: '',
      error: `Kind '${kind}' does not support credential probing`,
    }),
    send: async ({ targetId, notification }) => {
      const group = await deps.store.getById(targetId)
      if (group !== null && !group.enabled) return { success: false, error: 'Target is disabled' }
      return sendTo(group, targetId, notification)
    },
    testTarget: async ({ targetId, sample }) =>
      sendTo(await deps.store.getById(targetId), targetId, sample ?? CANNED),
  }
  return { provider, deliver, knownGroupIds: () => groupIds }
}
