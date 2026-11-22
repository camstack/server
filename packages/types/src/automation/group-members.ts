/**
 * What a command sent to a GROUP did on its members, read back for the trace of
 * the step that sent it. The group records one row per member it commanded
 * (`group-commands`, the latest attempt); the rows written at or after the moment
 * the step started are this command's, older ones belong to an earlier command.
 *
 * A slice that cannot be read or does not parse is `members: null` with the
 * reason, never `[]` — an empty list would claim that no member was commanded
 * (D393).
 */
import { GroupCommandsSchema } from '../capabilities/group-commands.cap.js'
import type { StepDeviceTrace } from './trace.js'

export type GroupMembersTrace = Pick<StepDeviceTrace, 'members' | 'membersNote'>

export function groupMembersTrace(slice: unknown, since: number): GroupMembersTrace {
  const parsed = GroupCommandsSchema.safeParse(slice)
  if (!parsed.success) {
    return { members: null, membersNote: 'the group has not recorded any member result' }
  }
  const mine = parsed.data.results.filter((row) => row.at >= since)
  if (mine.length === 0) {
    return { members: null, membersNote: 'no member result was recorded for this command' }
  }
  return {
    members: mine.map((row) => ({
      deviceId: row.deviceId,
      ok: row.ok,
      ...(row.error === undefined ? {} : { error: row.error }),
    })),
  }
}

/** The results could not be read at all: say why. */
export function groupMembersUnread(error: unknown): GroupMembersTrace {
  const reason = error instanceof Error ? error.message : String(error)
  return { members: null, membersNote: `the member results could not be read: ${reason}` }
}
