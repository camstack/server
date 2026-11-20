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
import {
  type AlarmState,
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
import { EMPTY_GROUP_CAPS, groupTargetKind } from './group-descriptor.js'
import { MemberLedger } from './member-ledger.js'

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
  let capsCache: { readonly at: number; readonly caps: TargetKindCaps } | null = null
  let computingCaps = false

  async function unionCaps(): Promise<TargetKindCaps> {
    // The catalogue read fans out to every provider, this one included: a re-entrant call answers
    // with what it has rather than asking itself.
    if (computingCaps) return capsCache?.caps ?? EMPTY_GROUP_CAPS
    if (capsCache !== null && deps.now() - capsCache.at < CAPS_TTL_MS) return capsCache.caps
    computingCaps = true
    try {
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
      const caps = unionTargetKindCaps(
        kinds.filter((kind) => memberKinds.has(kind.kind)).map((kind) => kind.caps),
      )
      capsCache = { at: deps.now(), caps }
      return caps
    } catch (err) {
      logger.warn('group caps union could not be read; serving the last one', {
        meta: { error: errMsg(err) },
      })
      return capsCache?.caps ?? EMPTY_GROUP_CAPS
    } finally {
      computingCaps = false
    }
  }

  async function deliverMember(
    group: Target,
    member: GroupMember,
    notification: Notification,
    notificationKey: string | null,
    targets: ReadonlyMap<string, NotificationTargetRef>,
    unreadableHolders: readonly string[],
  ): Promise<MemberOutcome> {
    const tags = { groupId: group.id }
    const skip = (reason: GroupSkipReason): MemberOutcome => {
      logger.info('group member skipped', {
        tags,
        meta: { groupId: group.id, targetId: member.targetId, reason },
      })
      return { targetId: member.targetId, status: 'skipped', reason }
    }
    const target = targets.get(member.targetId)
    if (target === undefined) {
      logger.warn('group member skipped: target not found', {
        tags,
        meta: {
          groupId: group.id,
          targetId: member.targetId,
          unreadableHolders,
        },
      })
      return {
        targetId: member.targetId,
        status: 'skipped',
        reason: 'unknown-target',
      }
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
    try {
      const result = await deps.sendToMember({
        addonId: target.addonId,
        targetId: member.targetId,
        notification: shapeForMember(member, notification),
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
    const outcomes: MemberOutcome[] = []
    for (const member of members) {
      outcomes.push(
        await deliverMember(group, member, notification, key, targets, unreadableHolders),
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
    listTargetKinds: async (): Promise<TargetKind[]> => [groupTargetKind(await unionCaps())],
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
