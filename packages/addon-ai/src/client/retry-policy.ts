/**
 * Who may retry, and who may not.
 *
 * The library retries with exponential backoff and honours `retry-after`. That
 * is exactly right for a 429 from a cloud endpoint and exactly wrong inside a
 * notification: `NcConfirmGate` gives the whole judgement 8 seconds, so a
 * second attempt does not produce a better answer — it produces a fail-open
 * notification that says nothing, twice as slowly. Before this table we had the
 * opposite bug: `retryAfterMs` was parsed off the header, written into the
 * result, and read by NOBODY, so a 429 was a hard error everywhere.
 *
 * Precedence, most specific first:
 *   1. the per-call `retry` on the request,
 *   2. this table, keyed by the mandatory `consumer` usage tag,
 *   3. `profile.retry`.
 *
 * A consumer NOT listed here falls through to the profile, which is why the
 * table names the interactive consumers explicitly rather than defaulting on.
 */
import type { LlmRetryPolicy } from '@camstack/types'

/** Interactive/batch consumers: a retry costs latency nobody is waiting on. */
const RETRYING: LlmRetryPolicy = { enabled: true, maxAttempts: 3 }
/** In-band gates: the call runs inside a budget a retry would blow. */
const NOT_RETRYING: LlmRetryPolicy = { enabled: false, maxAttempts: 1 }

export const CONSUMER_RETRY_POLICY: Readonly<Record<string, LlmRetryPolicy>> = {
  'adhoc-ui': RETRYING,
  'ai-summary': RETRYING,
  /** NcConfirmGate — 8 s total budget, fail-OPEN. */
  'notifier-rules': NOT_RETRYING,
  /** NcRuleAiAnalyst — the sentence on ONE notification, same 8 s budget and
   *  the same reason: somebody is holding a phone, and a retry produces a
   *  later notification rather than a better one. */
  'notifier-narration': NOT_RETRYING,
  /** SceneConfirmGate + checkSceneLlm — 8 s total budget, fail-CLOSED. */
  'scene-monitor': NOT_RETRYING,
}

export function resolveRetryPolicy(
  consumer: string,
  profileDefault: LlmRetryPolicy,
  override: LlmRetryPolicy | undefined,
): LlmRetryPolicy {
  if (override !== undefined) return override
  return CONSUMER_RETRY_POLICY[consumer] ?? profileDefault
}
