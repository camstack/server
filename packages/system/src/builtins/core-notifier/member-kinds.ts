/**
 * The kinds the members of a group can be: the `notification-output` catalogue minus the group's own
 * kind. The group is never a member of a group, so its kind is dropped HERE, at the source of the
 * read, rather than by a flag further down. A failed read throws: a catalogue that could not be read
 * is not an empty one (D49).
 */
import { NOTIFIER_GROUP_ADDON_ID, type TargetKindCaps } from '@dominevo/types'
import type { MemberKindCaps } from './group-notification-output.js'

interface KindRow {
  readonly kind: string
  readonly addonId: string
  readonly caps: TargetKindCaps
}

export interface MemberKindsApi {
  readonly notificationOutput: {
    readonly listTargetKinds: { query(input: Record<string, never>): Promise<readonly KindRow[]> }
  }
}

export async function readMemberKinds(api: MemberKindsApi): Promise<readonly MemberKindCaps[]> {
  const rows = await api.notificationOutput.listTargetKinds.query({})
  return rows
    .filter((row) => row.addonId !== NOTIFIER_GROUP_ADDON_ID)
    .map((row) => ({ kind: row.kind, caps: row.caps }))
}
