import { errMsg, type IScopedLogger } from '@dominevo/types'
import type { PushResult } from './sync-engine.js'
import type { LwaPausedReason, LwaPushState, LwaTokenEntry } from './types.js'

/** Wait before re-check N (0-based): 1, 2, 5, 15, 30 min, then 60 min for good. */
const BACKOFF_MS: readonly number[] = [1, 2, 5, 15, 30, 60].map((m) => m * 60_000)
const BACKOFF_CAP_MS = 60 * 60_000

export function pushRecheckDelayMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(0, attempts), BACKOFF_MS.length - 1)] ?? BACKOFF_CAP_MS
}

export type PausedPush = Extract<LwaPushState, { readonly state: 'paused' }>

export function isPaused(push: LwaPushState | undefined): push is PausedPush {
  return push?.state === 'paused'
}

/**
 * The next paused state. A fresh pause starts at attempt 0 (a 1 min re-check);
 * pausing again while already paused counts one more attempt and keeps `since`.
 */
export function nextPausedState(
  prev: LwaPushState | undefined,
  reason: LwaPausedReason,
  now: number,
): PausedPush {
  const attempts = isPaused(prev) ? prev.attempts + 1 : 0
  return {
    state: 'paused',
    reason,
    since: isPaused(prev) ? prev.since : now,
    attempts,
    nextCheckAt: now + pushRecheckDelayMs(attempts),
  }
}

/** `ok` only when every linked account can push; `paused` otherwise (no grant counts). */
export function pushStatusOf(
  linkedAccounts: readonly { readonly userId: string }[],
  tokens: readonly LwaTokenEntry[],
): 'ok' | 'paused' {
  if (linkedAccounts.length === 0) return 'ok'
  const live = linkedAccounts.every((a) => {
    const t = tokens.find((x) => x.userId === a.userId)
    return t !== undefined && !isPaused(t.push)
  })
  return live ? 'ok' : 'paused'
}

export interface ResumePushDeps {
  readonly pushAllToAccount: (userId: string) => Promise<PushResult>
  readonly refreshVisibility: () => Promise<unknown>
  readonly logger: IScopedLogger
}

/** The full push the paused events never delivered, run once a pause is lifted. Never throws. */
export async function pushAfterResume(userId: string, deps: ResumePushDeps): Promise<void> {
  try {
    const r = await deps.pushAllToAccount(userId)
    deps.logger.info('export-alexa: pushed to account after proactive pushes resumed', {
      meta: { ...r },
    })
    await deps.refreshVisibility()
  } catch (err) {
    deps.logger.warn('export-alexa: push after resume failed', {
      meta: { userId, error: errMsg(err) },
    })
  }
}
