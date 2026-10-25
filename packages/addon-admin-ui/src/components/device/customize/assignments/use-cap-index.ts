/**
 * Which source caps each device carries, from the registry index: one
 * `listDeviceIdsByCaps` per cap (≤ 10, cached) — never a `getBindings` per
 * device (D648: up to 5.24 s each). Answered only when every cap answered (D315).
 */
import { trpc } from '@camstack/ui-library'
import type { Known } from '../known'
import { capIndexOf } from './assignment-candidates'

export function useCapIndex(
  caps: readonly string[],
  enabled: boolean,
): Known<ReadonlyMap<number, readonly string[]>> {
  const queries = trpc.useQueries((t) =>
    caps.map((cap) => t.deviceManager.listDeviceIdsByCaps({ capNames: [cap] }, { enabled })),
  )
  return capIndexOf(
    caps.map((cap, i) => {
      const q = queries[i]
      return {
        cap,
        query:
          q === undefined
            ? { status: 'pending' }
            : {
                status: q.status,
                data: q.data,
                error: q.error === null ? null : { message: q.error.message },
              },
      }
    }),
  )
}
