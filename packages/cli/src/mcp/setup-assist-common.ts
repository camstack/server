/**
 * What the assisted-setup tools (`setup_*` reads, `configure_setup_*` writes)
 * share: a bounded-concurrency map, a proposal id, and the one admin refusal.
 *
 * A proposal is a plain object built from what the hub answered. Its id is a
 * digest of its body, so the same state yields the same id and a changed state
 * yields another one — an operator who confirms a proposal confirms THAT body.
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from '@camstack/develop'
import type { HubConnection } from '@camstack/develop'
import type { RefusedResult } from './ops-hub.js'

export const READ_CONCURRENCY = 6
export const CAMERA_LIMIT = 60

/** `items.map(fn)` with at most `limit` calls in flight; the order is kept. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      const item = items[i]
      if (item === undefined) return
      out[i] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

/** A short, stable id of a proposal body. */
export function proposalId(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 12)
}

/** The refusal every admin-tier read answers a non-admin credential with. */
export function adminRefusal(connection: HubConnection, what: string): RefusedResult | null {
  if (connection.tier === 'admin') return null
  return {
    status: 'refused',
    reason: `${what} is admin-tier and this credential is not admin-scoped.${connection.adminHint ? ` ${connection.adminHint}` : ''}`,
  }
}
