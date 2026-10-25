/**
 * A non-admin person with no viewer row is refused every labelled method.
 * Say so once per user: the same session retries, and a line per retry would
 * hide the one fact (who has no grant).
 */
import type { TrpcContextLogger } from './trpc.context.js'

const logged = new Set<string>()

export function logPersonWithoutViewer(
  logger: TrpcContextLogger | null | undefined,
  userId: string,
): void {
  if (logger == null || logged.has(userId)) return
  logged.add(userId)
  logger.warn('auth: a person with no viewer grant was refused', { tags: { userId } })
}

/** Test seam — the set is process-wide. */
export function resetPersonWithoutViewerLog(): void {
  logged.clear()
}
