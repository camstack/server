/**
 * The `notification-output` provider of the `group` kind: a send to a group is one send per member.
 *
 * Both senders reach a group with no change, because both address a target by `(addonId, targetId)`
 * read from the instances of `notification-output`: the notification center's `resolveTarget` and the
 * automation `sendToExportedTarget`. The group only has to be one of those instances.
 *
 * Rules: fan-out goes through `ctx.api.notificationOutput.send` (the `sendToMember` port); a member
 * that is itself a group is refused (`nested-group`); every skip is logged with its reason and the
 * group's tags (D391); a retry re-sends only the members that failed (the ledger); a test press bypasses that ledger
 * and the content filter. A member with `onlyIfUndelivered` is a fallback: tried only when none of the
 * members it names was delivered in the same send.
 * `SendResult.members` carries every member's outcome.
 */
import {
  type AlarmState,
  clampToCaps,
  decideMember,
  errMsg,
  escalationNeeded,
  type GroupMember,
  type GroupMemberOutcome,
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
} from '@camstack/types'
import { groupTargetKind } from './group-descriptor.js'
import { MemberLedger } from './member-ledger.js'

/** A target kind and what it delivers. */
export interface MemberKindCaps {
  readonly kind: string
  readonly caps: TargetKindCaps
}

/** What happened to one member of one send: the type of an entry of `SendResult.members`. */
export type MemberOutcome = GroupMemberOutcome

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
  /** The kind catalogue without the group's own kind: what each member's kind delivers. */
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
  readonly deliver: (
    group: Target,
    notification: Notification,
    isTest?: boolean,
  ) => Promise<GroupDeliveryReport>
} {
  const { logger } = deps
  async function deliverMember(
    group: Target,
    member: GroupMember,
    notification: Notification,
    notificationKey: string,
    targets: ReadonlyMap<string, NotificationTargetRef>,
    unreadableHolders: readonly string[],
    byKind: ReadonlyMap<string, TargetKindCaps>,
    isTest: boolean,
    earlier: readonly MemberOutcome[],
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
    // A test press is not an outbox retry: it never consults nor writes the delivered-set.
    if (!isTest && deps.ledger.wasDelivered(group.id, notificationKey, member.targetId)) {
      return skip('already-delivered')
    }
    const alarm =
      member.when?.kind === 'alarm' ? await deps.readAlarmState(member.when.deviceId) : undefined
    const decision = decideMember({
      member,
      notification,
      nowMs: deps.now(),
      ...(alarm !== undefined ? { alarmState: alarm } : {}),
      ...(isTest ? { ignoreFilter: true } : {}),
    })
    if (!decision.send) return skip(decision.reason)
    if (!escalationNeeded(member, earlier)) return skip('escalation-not-needed')
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
      if (!isTest) deps.ledger.markDelivered(group.id, notificationKey, member.targetId)
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

  async function deliver(
    group: Target,
    notification: Notification,
    isTest = false,
  ): Promise<GroupDeliveryReport> {
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
    const byKind = await deps
      .listMemberKinds()
      .then((kinds) => new Map(kinds.map((kind) => [kind.kind, kind.caps])))
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
        await deliverMember(
          group,
          member,
          notification,
          key,
          targets,
          unreadableHolders,
          byKind,
          isTest,
          outcomes,
        ),
      )
    }
    return { groupId: group.id, outcomes }
  }

  async function sendTo(
    group: Target | null,
    id: string,
    notification: Notification,
    isTest: boolean,
  ): Promise<SendResult> {
    if (group === null) return { success: false, error: `Unknown target '${id}'` }
    const report = await deliver(group, notification, isTest)
    const members = [...report.outcomes]
    const failed = members.some((outcome) => outcome.status === 'failed')
    return failed
      ? { success: false, error: summary(report.outcomes), members }
      : { success: true, members }
  }

  const provider: INotificationOutputProvider = {
    listTargetKinds: async (): Promise<TargetKind[]> => [groupTargetKind()],
    discoverTargets: async () => [],
    probeTargetConfig: async ({ kind }) => ({
      ok: false,
      resolvedUrl: '',
      error: `Kind '${kind}' does not support credential probing`,
    }),
    send: async ({ targetId, notification }) => {
      const group = await deps.store.getById(targetId)
      if (group !== null && !group.enabled) return { success: false, error: 'Target is disabled' }
      return sendTo(group, targetId, notification, false)
    },
    testTarget: async ({ targetId, sample }) =>
      sendTo(await deps.store.getById(targetId), targetId, sample ?? CANNED, true),
  }
  return { provider, deliver }
}
