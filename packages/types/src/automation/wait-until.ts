/**
 * The loop of a `wait-until` step (#500): read the condition, and while it is
 * not true wait for the next wake (a device report, the reconcile tick, a
 * restart) and read again, until the timeout.
 *
 * `unknown` is never "met" (D49): a condition that cannot be read keeps the
 * run waiting and, at the deadline, is what the timeout reports.
 */
import type { StepConditionVerdict } from './step-condition.js'

export interface WaitUntilInput {
  /** Read the condition NOW. A read that throws counts as `unknown`. */
  readonly read: () => Promise<StepConditionVerdict>
  readonly timeoutMs: number
  readonly now: () => number
  /** Resolve at the next reason to read again, and no later than `ms` from now. */
  readonly nextWake: (ms: number) => Promise<void>
  readonly isAborted: () => boolean
}

export type WaitUntilResult =
  | { readonly result: 'met'; readonly waitedMs: number }
  | { readonly result: 'timed-out'; readonly waitedMs: number; readonly lastReason: string }
  | { readonly result: 'aborted'; readonly waitedMs: number }

async function readSafely(read: WaitUntilInput['read']): Promise<StepConditionVerdict> {
  try {
    return await read()
  } catch (err: unknown) {
    return { result: 'unknown', reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function waitUntil(input: WaitUntilInput): Promise<WaitUntilResult> {
  const startedAt = input.now()
  const deadline = startedAt + input.timeoutMs
  for (;;) {
    const verdict = await readSafely(input.read)
    const waitedMs = input.now() - startedAt
    if (input.isAborted()) return { result: 'aborted', waitedMs }
    if (verdict.result === 'true') return { result: 'met', waitedMs }
    const remaining = deadline - input.now()
    if (remaining <= 0) return { result: 'timed-out', waitedMs, lastReason: verdict.reason }
    await input.nextWake(remaining)
    if (input.isAborted()) return { result: 'aborted', waitedMs: input.now() - startedAt }
  }
}

/** What the run trace says of a wait that ran out. */
export function waitTimedOutMessage(timeoutS: number, lastReason: string): string {
  return `timed out after ${timeoutS} s: ${lastReason}`
}
