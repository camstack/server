/**
 * Pure helpers behind the "Remove ids from Alexa" Troubleshooting action: the
 * operator types endpoint ids, a DeleteReport goes to every linked account, and
 * the local tracking forgets an id only after every account accepted it.
 */
import type { PurgeEndpointsResult } from './lwa-event-gateway.js'

/** Comma / whitespace / newline separated ids → unique non-empty ids. */
export function parseEndpointIds(raw: string): readonly string[] {
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return [...new Set(ids)]
}

/**
 * The tracked map (deviceId → endpoint ids last pushed) without `removed`. A
 * device left with no id is dropped, so no later DeleteReport re-addresses it.
 */
export function forgetDeliveredEndpointIds(
  tracked: Readonly<Record<number, readonly string[]>>,
  removed: readonly string[],
): Record<number, readonly string[]> {
  const gone = new Set(removed)
  const next: Record<number, readonly string[]> = {}
  for (const [key, ids] of Object.entries(tracked)) {
    const remaining = ids.filter((id) => !gone.has(id))
    if (remaining.length > 0) next[Number(key)] = remaining
  }
  return next
}

export interface RemoveEndpointsDeps {
  /** What the operator typed in the button's prompt. */
  readonly raw: string
  /** DeleteReport to every linked account (`LwaEventGateway.purgeEndpoints`). */
  readonly purge: (ids: readonly string[]) => Promise<PurgeEndpointsResult>
  readonly getTracked: () => Readonly<Record<number, readonly string[]>>
  readonly setTracked: (next: Readonly<Record<number, readonly string[]>>) => Promise<void>
}

/**
 * Delete the typed ids from every linked Alexa account. Throws — so the button
 * shows the reason — unless every account accepted the delete; only then are
 * the ids forgotten locally. A partial delivery keeps them tracked, so a
 * Re-sync or a second press can still reach the account that missed it.
 */
export async function removeEndpointsFromAlexa(
  deps: RemoveEndpointsDeps,
): Promise<PurgeEndpointsResult> {
  const ids = parseEndpointIds(deps.raw)
  if (ids.length === 0) {
    throw new Error('No endpoint id given. Type one or more ids, e.g. 54, 54__privacy.')
  }
  const result = await deps.purge(ids)
  if (result.accountCount === 0) {
    throw new Error('No linked Amazon account: there is no Alexa account to remove them from.')
  }
  if (result.failedAccounts > 0) {
    throw new Error(
      `The delete did not reach ${result.failedAccounts} of ${result.accountCount} linked account(s); nothing was forgotten. The addon log has the gateway's answer.`,
    )
  }
  await deps.setTracked(forgetDeliveredEndpointIds(deps.getTracked(), ids))
  return result
}
