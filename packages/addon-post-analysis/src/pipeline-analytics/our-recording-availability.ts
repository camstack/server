/**
 * Coverage of OUR archive, asked of the `recording` collection by name.
 *
 * `recording` became a device collection on 2026-09-24 (D625): a camera may
 * have several sources of recorded coverage and every read names one. Every
 * read in this addon wants the same one — the footage OUR recorder wrote,
 * because everything downstream of it (a recorded clip cut, a timelapse) is
 * about bytes we hold and can export. The retention sweep's earliest-footage
 * floor is NOT asked here any more: it is one number the archive's ledger
 * already folds, and asking it as coverage from the epoch walked every hour
 * since 1970 (D674, `retention/archive-footage-floor.ts`). A camera's own SD card is not an answer to any of those questions.
 *
 * It also owns the `read: 'unreadable'` rule, in one place: a read that FAILED
 * throws here rather than arriving downstream as an empty range list. Every
 * caller of this module treats "no ranges" as "recording is off for this
 * camera" and acts on it — dropping the attachment, skipping the render —
 * so folding a failed read into that shape would
 * make an unreachable recorder look exactly like a camera nobody records
 * (D393). The callers already handle a throw and log it as a read failure.
 */
import { RECORDING_SOURCE_CAMSTACK_ADDON } from '@camstack/types'

/** The bit of the addon api this module needs. Structural, so the real
 *  `ctx.api` satisfies it and a test double can too. */
export interface OurRecordingApi {
  readonly recording: {
    readonly getAvailability: {
      query(input: {
        deviceId: number
        provider: string
        fromMs: number
        toMs: number
        profile?: string
      }): Promise<{
        readonly read: 'read' | 'unreadable'
        readonly ranges: readonly { profile: string; startMs: number; endMs: number }[]
        readonly profilesWithFootage: readonly string[]
      }>
    }
  }
}

export interface OurAvailabilityInput {
  readonly deviceId: number
  readonly fromMs: number
  readonly toMs: number
  readonly profile?: string
}

export interface OurAvailability {
  readonly ranges: readonly { profile: string; startMs: number; endMs: number }[]
  readonly profilesWithFootage: readonly string[]
}

/** Our coverage of `[fromMs, toMs)`, or a throw naming the failed read. */
export async function ourRecordingAvailability(
  api: OurRecordingApi,
  input: OurAvailabilityInput,
): Promise<OurAvailability> {
  const answer = await api.recording.getAvailability.query({
    deviceId: input.deviceId,
    provider: RECORDING_SOURCE_CAMSTACK_ADDON,
    fromMs: input.fromMs,
    toMs: input.toMs,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
  })
  if (answer.read === 'unreadable') {
    throw new Error(
      `recording.getAvailability: the CamStack archive was unreadable for device ${String(input.deviceId)} — no claim is made about its footage`,
    )
  }
  return { ranges: answer.ranges, profilesWithFootage: answer.profilesWithFootage }
}
