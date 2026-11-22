/**
 * Turning a rule that delivers to several notifiers into one notifier group (D1071): the members
 * the group gets, and what of the rule's per-notifier settings a member cannot hold.
 */
import {
  NOTIFIER_GROUP_KIND,
  NotificationFieldSchema,
  type GroupMember,
  type NcRule,
  type NcTargetOverride,
  type NotificationField,
  type Target,
} from '@camstack/types'

/** A per-notifier setting of the rule that the group member does not carry. */
export type NotCarriedSetting = 'template' | 'priority' | 'attachment-kind' | 'params'

export interface NotCarried {
  readonly targetId: string
  readonly setting: NotCarriedSetting
}

export interface RuleGroupPlan {
  readonly members: readonly GroupMember[]
  readonly notCarried: readonly NotCarried[]
}

/** A rule can become a group when it delivers to two or more notifiers and none of them is a group. */
export function canConvertToGroup(
  rule: Pick<NcRule, 'targets'>,
  targets: readonly Pick<Target, 'id' | 'kind'>[] | undefined,
): boolean {
  if (rule.targets.length < 2 || targets === undefined) return false
  const groups = new Set(targets.filter((t) => t.kind === NOTIFIER_GROUP_KIND).map((t) => t.id))
  return !rule.targets.some((target) => groups.has(target.targetId))
}

function fieldsOf(
  override: NcTargetOverride | undefined,
): readonly NotificationField[] | undefined {
  const dropped = new Set<NotificationField>()
  if (override?.attachment === 'none') dropped.add('attachments')
  if (override?.actions === false) dropped.add('actions')
  if (dropped.size === 0) return undefined
  return NotificationFieldSchema.options.filter((field) => !dropped.has(field))
}

/** The group members that deliver what the rule's targets delivered, and what they cannot hold. */
export function planRuleGroup(
  rule: Pick<NcRule, 'targets' | 'targetOverrides' | 'disabledTargetIds'>,
): RuleGroupPlan {
  const notCarried: NotCarried[] = []
  const members = rule.targets.map((target): GroupMember => {
    const override = rule.targetOverrides?.[target.targetId]
    const fields = fieldsOf(override)
    const miss = (setting: NotCarriedSetting): void => {
      notCarried.push({ targetId: target.targetId, setting })
    }
    if (override?.template?.title !== undefined || override?.template?.body !== undefined) {
      miss('template')
    }
    if (override?.priority !== undefined) miss('priority')
    if (override?.attachment !== undefined && override.attachment !== 'none')
      miss('attachment-kind')
    if (target.params !== undefined && Object.keys(target.params).length > 0) miss('params')
    return {
      targetId: target.targetId,
      ...(rule.disabledTargetIds.includes(target.targetId) ? { enabled: false } : {}),
      ...(override?.schedule !== undefined
        ? { when: { kind: 'schedule', schedule: override.schedule } }
        : {}),
      ...(fields !== undefined ? { fields: [...fields] } : {}),
    }
  })
  return { members, notCarried }
}
