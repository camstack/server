/**
 * Two locations of the SAME type must not share a physical root (D389).
 *
 * ## What is legitimate and must stay legitimate
 *
 * Two locations of DIFFERENT types on one root is a designed configuration, not
 * an accident: stock `recordings` and `recordingsLow` deliberately share a root
 * (D327 scores occupancy by class SUBTREE — `high|mid` against `low` — and the
 * recorder's eviction domain merges same-root aliases into one oldest-first
 * pool on purpose). A check that refused every shared root would break the
 * default install.
 *
 * ## What is a collision
 *
 * Two locations of the same TYPE on one physical root. Their class subtrees are
 * identical, so every per-location figure double-counts and every deletion
 * under one is a deletion under the other. The recorder already has a late
 * parachute for this — `demoteWritableAliasConflicts` demotes the extras to
 * read-only and logs — but by then the operator has created the row and may
 * have pointed configuration at it. This refuses it at the door, and the
 * parachute stays: it still guards rows created before this check existed, and
 * a guard that only exists at the door is not a guard.
 *
 * Containment counts, in BOTH directions. A location nested inside another's
 * tree is worse than two equal roots: the accounting overlaps and a deletion
 * under the outer one can take the inner one's footage with it.
 *
 * ## "They collide" is not "I cannot tell"
 *
 * A location on another node, or behind a remote provider, cannot be resolved
 * from here. An unresolvable root produces a WARNING and lets the write
 * through — never a refusal. Refusing on an unanswerable read blocks the
 * operator on a doubt (D49's spirit: a fallible read is not the gate).
 *
 * Pure: the realpath derivation is injected.
 */
import type { PhysicalRoot } from '@camstack/types/node'
import { containsOrEquals } from '@camstack/types/node'

/** The minimum a row must expose for this check. */
export interface RootCollisionCandidate {
  readonly id: string
  readonly type: string
  /** Which node the path lives on. Two locations on DIFFERENT nodes can never
   *  collide, however identical their paths look. */
  readonly nodeId?: string
  readonly config: Readonly<Record<string, unknown>>
}

/** How this location's physical root was derived, or that it could not be. */
export type ResolveRoot = (basePath: string) => PhysicalRoot

/** A same-type root collision, with everything the message needs to name it. */
export interface RootCollision {
  readonly otherId: string
  readonly type: string
  readonly sharedRoot: string
  /** `equal` — the same directory. `nested` — one inside the other's tree. */
  readonly kind: 'equal' | 'nested'
}

/** Why the check could not be made. Never a refusal — the caller warns. */
export interface RootCollisionUnknown {
  readonly reason: 'no-base-path' | 'unresolvable'
  readonly detail: string
}

export type RootCollisionVerdict =
  | { readonly outcome: 'clear' }
  | { readonly outcome: 'collides'; readonly collision: RootCollision }
  | { readonly outcome: 'unknown'; readonly unknown: RootCollisionUnknown }

function basePathOf(row: RootCollisionCandidate): string | null {
  const raw = row.config['basePath']
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** Both rows on one node? Absent `nodeId` means the hub (the seed writes
 *  node-blind rows), so the comparison normalises rather than skipping. */
function sameNode(a: RootCollisionCandidate, b: RootCollisionCandidate): boolean {
  return (a.nodeId ?? 'hub') === (b.nodeId ?? 'hub')
}

/**
 * Does `next` collide with anything already stored?
 *
 * `existing` is every other location; the row being EDITED is excluded by id,
 * so re-saving a location without moving its root never refuses itself.
 */
export function findRootCollision(
  next: RootCollisionCandidate,
  existing: Iterable<RootCollisionCandidate>,
  resolveRoot: ResolveRoot,
  storedSelf?: RootCollisionCandidate,
): RootCollisionVerdict {
  // An edit that does not MOVE the root is never refused, even when the stored
  // row already collides with a sibling. A pre-existing collision (a row
  // created before this check, or one the recorder has already demoted) must
  // stay editable — refusing it would leave the operator unable to rename,
  // re-point or even disable the very location they need to fix.
  if (storedSelf !== undefined && basePathOf(storedSelf) === basePathOf(next)) {
    return { outcome: 'clear' }
  }
  const basePath = basePathOf(next)
  if (basePath === null) {
    // A provider with no path (S3, WebDAV) has no physical root to share.
    return { outcome: 'clear' }
  }
  const root = resolveRoot(basePath)
  if (!root.resolved) {
    return {
      outcome: 'unknown',
      unknown: {
        reason: 'unresolvable',
        detail: `could not resolve "${basePath}" on this node`,
      },
    }
  }

  for (const other of existing) {
    if (other.id === next.id) continue
    if (other.type !== next.type) continue
    if (!sameNode(other, next)) continue
    const otherPath = basePathOf(other)
    if (otherPath === null) continue
    const otherRoot = resolveRoot(otherPath)
    // An UNRESOLVABLE sibling is not evidence of anything. Skipping it can only
    // let a collision through, which the recorder's demotion still catches;
    // treating it as a match would refuse on a read that failed.
    if (!otherRoot.resolved) continue
    if (root.key === otherRoot.key) {
      return {
        outcome: 'collides',
        collision: { otherId: other.id, type: next.type, sharedRoot: root.key, kind: 'equal' },
      }
    }
    if (containsOrEquals(otherRoot.key, root.key)) {
      return {
        outcome: 'collides',
        collision: {
          otherId: other.id,
          type: next.type,
          sharedRoot: otherRoot.key,
          kind: 'nested',
        },
      }
    }
    if (containsOrEquals(root.key, otherRoot.key)) {
      return {
        outcome: 'collides',
        collision: { otherId: other.id, type: next.type, sharedRoot: root.key, kind: 'nested' },
      }
    }
  }
  return { outcome: 'clear' }
}

/** The operator-facing refusal. Names the location it collides with and the
 *  shared root — a refusal that says only "conflict" makes the operator hunt. */
export function rootCollisionMessage(id: string, collision: RootCollision): string {
  const relation =
    collision.kind === 'equal'
      ? `the same directory as "${collision.otherId}"`
      : `nested with "${collision.otherId}" (one is inside the other's tree)`
  return (
    `Cannot save "${id}": it is ${relation}, and both are type "${collision.type}". ` +
    `Two locations of one type on the same disk share a class subtree, so every ` +
    `per-location figure double-counts and a deletion under one is a deletion under ` +
    `the other. Shared root: ${collision.sharedRoot}. ` +
    `Two locations of DIFFERENT types may share a root — that is how recordings and ` +
    `recordingsLow are configured by default.`
  )
}
