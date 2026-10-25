/**
 * "Does this cluster have capability X?" — asked of the authority, answered in
 * a shape that can say *I do not know yet*.
 *
 * WHY THIS EXISTS. A panel that gates on a component being installed has three
 * things to say and a `boolean` can carry two. The missing one is the one an
 * operator sees first: the query has not answered. Collapsing it into `false`
 * makes the UI assert, in words, that a component is NOT INSTALLED — while it
 * is installed and running. That is the failure
 * [D62](../../../../docs/decisions/adr-0062.md) names for a switch ("disabled
 * must never look like broken"); the same rule holds one step earlier:
 * **not-yet-known must never look like not-installed.** An operator who reads
 * "not installed" goes hunting a fault that does not exist.
 *
 * So the answer is a discriminated `CapabilityPresence`, never a boolean, and
 * `'pending'` / `'unknown'` are values a caller has to render — not defaults
 * it falls into.
 *
 * WHY THE REGISTRY AND NOT THE TOPOLOGY. The previous gate read
 * `nodes.topology` and scanned every node's addon list for the capability id.
 * That endpoint's handler walks the whole cluster to build a diagram: a
 * `$agent.status` + `$process.list` round trip per online node, a `ps` sample
 * of every child pid on every node, one durable history-store write per online
 * node, plus the persisted-history read — all sequential. Measured on the
 * production hub (2026-08-31): **32.4 s / 33.9 s / 51.1 s**, 80.7 KB, for a
 * one-bit answer. `capabilities.getCapability` is a `Map.get` on the hub's
 * `CapabilityRegistry` — the same registry every provider registers into via
 * the atomic `registerNode` RPC, so it sees agent-hosted providers too (three
 * node ids on the reference cluster). Measured: **0.15 s**, ~250 bytes, and
 * the cost does not grow with the fleet.
 *
 * WHY NOT A CACHE. [D224](../../../../docs/decisions/adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
 * is explicit that a consumer never keeps a second copy of a fact the owner
 * already holds. This hook keeps none: every mount asks the registry, and the
 * registry is the authority. The fix for a slow read was a smaller question,
 * not a local mirror of the big answer.
 */
import type { CapabilityInfo } from '@camstack/types'
import { trpc } from '../trpc-react.js'

/**
 * What is known about a capability's presence in this cluster.
 *
 * - `pending` — the registry has not answered. Render progress, never absence.
 * - `present` — the registry answered and at least one addon provides it.
 * - `absent`  — the registry answered, and nothing provides it (either the
 *               capability is undeclared, or it is declared with no provider).
 * - `unknown` — the read FAILED. Not an answer, so it is not `absent` either;
 *               a surface that cannot reach the registry says so.
 */
export type CapabilityPresence = 'pending' | 'present' | 'absent' | 'unknown'

/**
 * Classify a settled registry answer.
 *
 * `null` is "no such capability". A row with an empty `providers` list is a
 * capability that is DECLARED but that no addon supplies — indistinguishable
 * to an operator from not having it, and the panel behind it would have
 * nothing to call. Both are `absent`.
 *
 * Exported for the unit test: the mapping is the whole decision, and it is
 * worth pinning without a React tree around it.
 */
export function classifyCapability(row: CapabilityInfo | null): 'present' | 'absent' {
  if (row === null) return 'absent'
  return row.providers.length > 0 ? 'present' : 'absent'
}

/**
 * Ask the hub's capability registry whether `capabilityName` has a provider.
 *
 * The four states map straight off React Query's `status`, so there is no
 * place for a nullish fallback to turn "no answer" into "no providers" — the
 * exact collapse this hook exists to make unrepresentable.
 */
export function useCapabilityPresence(capabilityName: string): CapabilityPresence {
  const query = trpc.capabilities.getCapability.useQuery({ name: capabilityName })
  if (query.status === 'pending') return 'pending'
  if (query.status === 'error') return 'unknown'
  return classifyCapability(query.data)
}
