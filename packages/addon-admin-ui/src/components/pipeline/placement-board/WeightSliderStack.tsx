/**
 * WeightSliderStack — coordinated detection-weight editor.
 *
 * One horizontal slider per detect-capable node, stacked vertically. Each
 * slider is the node's relative SHARE of the cluster's detection load. The
 * shares ALWAYS sum to 100 (the distribution is conserved).
 *
 * LOCKED nodes hold a fixed slice of the 100% budget: they are NEVER moved and
 * NEVER re-scaled. Dragging slider `i` only ever moves `i` + the UNLOCKED,
 * non-dragged sliders — together they share whatever budget the locks leave
 * (`100 - lockedSum`). The remaining budget after the dragged value is split
 * EQUALLY across the unlocked others. Because the total is conserved at 100, a
 * subsequent `sharesFromNodes` normalise (after the commit round-trips back
 * from the server) can never shrink a locked node — that re-normalisation of
 * an over-100 total was the recurring "locking a slider doesn't hold it" bug.
 *
 * The dragged slider is bounded by the non-locked headroom: it can rise only to
 * `100 - lockedSum`, never past what the unlocked pool can give back. If EVERY
 * other node is locked there is no unlocked slider to absorb a change, so the
 * dragged slider is pinned to the headroom (it cannot move).
 *
 * On release, EVERY node whose rounded share actually changed vs its last
 * persisted weight is committed as its absolute weight, PLUS any locked node
 * (so a locked share is always re-affirmed alongside a change elsewhere and
 * the persisted set never drifts out of sync with the on-screen shares) — via
 * one `onCommitWeights(entries)` call. The rounded integer weights sum to
 * EXACTLY 100 with any rounding remainder pushed onto an UNLOCKED slider,
 * never a locked one. The caller writes the whole batch in ONE request: the
 * Load balancing tab through `setLoadBalancingShares` (one atomic
 * read-modify-write of every node's share, D748), a node's accelerator stack
 * through its node's single `setAgentInferenceDevices` write. A write per
 * entry would race — that was the original "random numbers" bug.
 *
 * The lock is a client-side editing aid (which sliders may move during a
 * redistribution), not a persisted setting — a locked node's own share is
 * unchanged by a drag elsewhere, so it only needs re-persisting if it was
 * itself edited (it is still re-affirmed in the commit batch alongside any
 * change, which is a harmless no-op write when its value is unchanged).
 *
 * `packages/addon-admin-ui/src/components/pipeline/__tests__/
 * weight-slider-stack.spec.tsx` covers `redistribute`/`sharesFromNodes`, and
 * `weight-slider-stack-commit.spec.tsx` covers the commit-set behavior.
 *
 * NOTE: weight only distributes detection among nodes that can SOURCE a
 * camera's frames. When a single node owns the frame source for every camera
 * (e.g. hub ingests + decodes all of them and cross-node remote-sourcing is
 * off), the weights are inert — everything resolves to that one node.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Lock, Unlock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Minimal shape the stack actually reads — `id` (stable key), `name` (row
 * label) and `weight` (persisted absolute weight, normalised into a share).
 *
 * The Load balancing tab passes cluster nodes and `NodeInferenceDevices`
 * passes per-ACCELERATOR entries. Anything with these three
 * fields drives the same coordinated slider stack — the semantics ("shares that
 * always sum to 100, lock/redistribute") are identical whether the items are
 * cluster nodes or a node's inference devices.
 */
export interface WeightSliderNode {
  readonly id: string
  readonly name: string
  readonly weight: number
}

/** One item's absolute weight to persist. */
export interface WeightCommitEntry {
  readonly nodeId: string
  readonly weight: number
}

export interface WeightSliderStackProps {
  /** The items sharing the 100% budget (cluster nodes OR a node's accelerators). */
  readonly nodes: readonly WeightSliderNode[]
  readonly pending: boolean
  /** Commit every changed (+ locked) item's absolute weight in one call; the
   *  caller persists the batch in ONE write. */
  readonly onCommitWeights: (entries: readonly WeightCommitEntry[]) => void
  /** Accessible label prefix for each slider (default: "Detection weight"). */
  readonly weightLabel?: string
  /** Copy shown when `nodes` is empty (default: the cluster-node hint). */
  readonly emptyHint?: ReactNode
  /** Explanatory footnote under the stack (default: the cluster-node note). */
  readonly footnote?: ReactNode
  /**
   * Shares the system owns (automatic shares, D750): shown, never dragged or
   * locked. The caller explains where they come from in `footnote`.
   */
  readonly readOnly?: boolean
}

type ShareMap = Readonly<Record<string, number>>

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Normalise the persisted absolute weights into shares summing to 100. */
export function sharesFromNodes(nodes: readonly WeightSliderNode[]): ShareMap {
  const total = nodes.reduce((sum, node) => sum + Math.max(node.weight, 0), 0)
  if (total <= 0) {
    const equal = nodes.length > 0 ? 100 / nodes.length : 0
    return Object.fromEntries(nodes.map((node) => [node.id, equal]))
  }
  return Object.fromEntries(
    nodes.map((node) => [node.id, (Math.max(node.weight, 0) / total) * 100]),
  )
}

/**
 * Move `id` to `rawValue` while keeping the whole distribution conserved at 100
 * and every LOCKED share byte-for-byte fixed.
 *
 * Locked nodes (other than the one being dragged) hold a fixed slice of the
 * 100% budget. The dragged slider + the UNLOCKED others share the remaining
 * `100 - lockedSum` (the "headroom"): the dragged value is clamped to
 * `[0, headroom]` and whatever is left after it is split EQUALLY across the
 * unlocked others (a node's prior share never biases the split). If there is no
 * unlocked other to absorb a change, the dragged slider is pinned to the exact
 * headroom — the only value that keeps the total at 100.
 *
 * Because the total is always conserved at 100 (never "pinned on top" past
 * 100), a later `sharesFromNodes` normalise cannot shrink a locked node.
 */
export function redistribute(
  prev: ShareMap,
  id: string,
  rawValue: number,
  locked: ReadonlySet<string>,
  ids: readonly string[],
): ShareMap {
  const lockedSum = ids
    .filter((x) => x !== id && locked.has(x))
    .reduce((total, x) => total + Math.max(prev[x] ?? 0, 0), 0)
  const headroom = Math.max(0, 100 - lockedSum)
  const others = ids.filter((x) => x !== id && !locked.has(x))

  // With no unlocked other to absorb a change, the dragged slider can only sit
  // at the headroom (any other value would break the conserved total).
  const newValue = others.length === 0 ? headroom : clamp(rawValue, 0, headroom)

  const next: Record<string, number> = { ...prev, [id]: newValue }
  if (others.length > 0) {
    const equal = Math.max(0, headroom - newValue) / others.length
    for (const x of others) next[x] = equal
  }
  return next
}

/**
 * Round float shares to integer weights that sum to EXACTLY 100, pushing any
 * rounding remainder onto UNLOCKED sliders only — a locked share is rounded to
 * its nearest integer and NEVER nudged to make the total land on 100. Uses
 * largest-remainder apportionment across the unlocked pool.
 */
export function roundShares(
  shares: ShareMap,
  ids: readonly string[],
  locked: ReadonlySet<string>,
): ShareMap {
  const result: Record<string, number> = {}
  let lockedTotal = 0
  const pool: { readonly id: string; readonly floor: number; readonly frac: number }[] = []

  for (const id of ids) {
    const value = Math.max(shares[id] ?? 0, 0)
    if (locked.has(id)) {
      const rounded = Math.round(value)
      result[id] = rounded
      lockedTotal += rounded
    } else {
      const floor = Math.floor(value)
      result[id] = floor
      pool.push({ id, floor, frac: value - floor })
    }
  }

  const budget = Math.max(0, 100 - lockedTotal)
  const assigned = pool.reduce((total, entry) => total + entry.floor, 0)
  let remainder = budget - assigned

  // Hand out (or claw back) whole units on the UNLOCKED pool by fractional part.
  const byFracDesc = [...pool].sort((a, b) => b.frac - a.frac)
  for (let i = 0; remainder > 0 && byFracDesc.length > 0; i += 1) {
    result[byFracDesc[i % byFracDesc.length].id] += 1
    remainder -= 1
  }
  const byFracAsc = [...pool].sort((a, b) => a.frac - b.frac)
  for (let i = 0; remainder < 0 && byFracAsc.length > 0; i += 1) {
    const target = byFracAsc[i % byFracAsc.length].id
    if (result[target] > 0) {
      result[target] -= 1
      remainder += 1
    }
  }
  return result
}

export function WeightSliderStack({
  nodes,
  pending,
  onCommitWeights,
  weightLabel = 'Detection weight',
  emptyHint,
  footnote,
  readOnly = false,
}: WeightSliderStackProps) {
  const { t } = useTranslation()
  const [shares, setShares] = useState<ShareMap>(() => sharesFromNodes(nodes))
  const [locked, setLocked] = useState<ReadonlySet<string>>(new Set())

  // Re-sync from the server whenever the node set or persisted weights change
  // (the signature captures both). Purely local edits don't change the
  // signature, so an in-flight drag isn't clobbered by our own optimistic
  // commit round-tripping back.
  const signature = nodes.map((node) => `${node.id}:${node.weight}`).join('|')
  useEffect(() => {
    setShares(sharesFromNodes(nodes))
    setLocked((prev) => new Set([...prev].filter((id) => nodes.some((node) => node.id === id))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const ids = nodes.map((node) => node.id)

  const toggleLock = (id: string): void => {
    setLocked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDrag = (id: string, value: number): void => {
    setShares((prev) => redistribute(prev, id, value, locked, ids))
  }

  // Commit the FULL current share set for every node whose rounded share
  // changed vs its last persisted weight, plus any locked node (so a pinned
  // share is always re-affirmed alongside a change elsewhere) — see the
  // module doc comment for why every entry must be persisted together, in
  // one write.
  const commit = (): void => {
    // Round the whole live distribution to integer weights summing to exactly
    // 100 (remainder pushed onto unlocked sliders), then commit every node
    // whose weight actually changed vs its persisted value, plus any locked
    // node so a pinned share is always re-affirmed in the same batch.
    const rounded = roundShares(shares, ids, locked)
    const changedIds = nodes
      .filter((node) => (rounded[node.id] ?? 0) !== node.weight)
      .map((node) => node.id)
    if (changedIds.length === 0) return
    const entryIds = new Set([...changedIds, ...locked])
    const entries = nodes
      .filter((node) => entryIds.has(node.id))
      .map((node) => ({ nodeId: node.id, weight: rounded[node.id] ?? 0 }))
    onCommitWeights(entries)
  }

  if (nodes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-background px-4 py-6 text-center text-xs text-foreground-subtle">
        {emptyHint ??
          t(
            'placementBoard.weightSliderStack.noDetectEnabledNodesEnable',
            'No detect-enabled nodes. Enable “Detect” on a node above to distribute detection weight.',
          )}
      </p>
    )
  }

  const soleNode = nodes.length === 1

  return (
    <div className="space-y-3">
      {nodes.map((node) => {
        const share = shares[node.id] ?? 0
        const isLocked = locked.has(node.id)
        return (
          <div key={node.id} className="flex items-center gap-3">
            <span
              className="w-28 shrink-0 truncate text-xs font-medium text-foreground"
              title={node.name}
            >
              {node.name}
            </span>
            <input
              aria-label={t(
                'placementBoard.weightSliderStack.for',
                '{{weightLabel}} for {{name}}',
                { weightLabel, name: node.name },
              )}
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(share)}
              disabled={readOnly || pending || isLocked || soleNode}
              onChange={(event) => handleDrag(node.id, Number(event.target.value))}
              onPointerUp={() => commit()}
              onKeyUp={() => commit()}
              className="h-1.5 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
              {Math.round(share)}%
            </span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => toggleLock(node.id)}
                disabled={pending || soleNode}
                aria-pressed={isLocked}
                title={
                  isLocked
                    ? t(
                        'placementBoard.weightSliderStack.unlockAllowRebalancing',
                        'Unlock — allow rebalancing',
                      )
                    : t(
                        'placementBoard.weightSliderStack.lockThisShareWhenOthers',
                        'Lock this share when others change',
                      )
                }
                className={`shrink-0 rounded p-1 hover:bg-surface-hover disabled:opacity-40 ${
                  isLocked ? 'text-amber-400' : 'text-foreground-subtle'
                }`}
              >
                {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        )
      })}
      <p className="text-[10px] leading-tight text-foreground-subtle">
        {footnote ?? (
          <>
            {t(
              'placementBoard.weightSliderStack.draggingOneSliderSplitsThe',
              'Dragging one slider splits the rest equally across the unlocked nodes; lock a node to pin its share — locked nodes never move and the total always stays at 100%, so a drag is bounded by the room the unlocked nodes leave. Detection only distributes across nodes that can source a camera’s frames.',
            )}
          </>
        )}
      </p>
    </div>
  )
}
