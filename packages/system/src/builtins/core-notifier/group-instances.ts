/**
 * What the core-notifier hands the shared notification-target instance door: the `group` kind and the
 * save rule of its body. A group is refused when a member row cannot be read, when a target is listed
 * twice, and when a member is itself a group (nesting is never delivered; the send skips it as well).
 */
import {
  type GroupMember,
  type IIntegrationInstancesProvider,
  GroupMemberSchema,
  type NotificationTargetInstancesSpec,
  NOTIFIER_GROUP_KIND,
} from '@camstack/types'
import { groupRecordKinds, groupTargetKind } from './group-descriptor.js'

export interface GroupInstancesDeps {
  readonly mintId: () => string
  /** The ids of the groups as last read. */
}

/** The members of a form body, or the reason the body cannot be saved. */
export function validateGroupMembers(
  config: Readonly<Record<string, unknown>>,
  groupIds: ReadonlySet<string>,
): readonly GroupMember[] {
  const rows = config['members']
  if (rows === undefined) return []
  if (!Array.isArray(rows)) throw new Error('A group needs a list of members')
  const members: GroupMember[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const parsed = GroupMemberSchema.safeParse(row)
    if (!parsed.success) throw new Error('A group member row is not valid: it needs a notifier')
    const { targetId } = parsed.data
    if (seen.has(targetId)) throw new Error(`The notifier ${targetId} is listed twice`)
    seen.add(targetId)
    if (groupIds.has(targetId)) throw new Error('A group cannot contain another group')
    members.push(parsed.data)
  }
  return members
}

/** The save rule that needs no other record: rows readable, no duplicate. Nesting is checked against the store. */
const NO_GROUPS: ReadonlySet<string> = new Set()

export function groupInstancesSpec(deps: GroupInstancesDeps): NotificationTargetInstancesSpec {
  return {
    descriptors: [groupTargetKind()],
    kinds: groupRecordKinds,
    mintId: deps.mintId,
    canProbe: () => false,
    validate: ({ kind, config }) => {
      if (kind !== NOTIFIER_GROUP_KIND) return undefined
      validateGroupMembers(config, NO_GROUPS)
      return undefined
    },
  }
}

/**
 * The instances provider with the nested-group rule in front of every write: the ids of the groups
 * are read from the store (async), so the rule is a step before `createInstance` / `updateInstance`
 * rather than the synchronous save rule of the spec.
 */
export function refuseNestedGroups(
  provider: IIntegrationInstancesProvider,
  listGroupIds: () => Promise<ReadonlySet<string>>,
): IIntegrationInstancesProvider {
  const check = async (values: Readonly<Record<string, unknown>> | undefined): Promise<void> => {
    if (values === undefined) return
    validateGroupMembers(values, await listGroupIds())
  }
  return {
    ...provider,
    createInstance: async (input, ...rest) => {
      await check(input.values)
      return provider.createInstance(input, ...rest)
    },
    updateInstance: async (input, ...rest) => {
      await check(input.values)
      return provider.updateInstance(input, ...rest)
    },
  }
}
