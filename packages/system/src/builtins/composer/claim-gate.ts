/**
 * The D49 gate over RELEASING a claim (D663).
 *
 * A composition on an existing device owns fields of the device through claims
 * on the hub, keyed by the block id. When the block is deleted, disabled, or
 * loses a feature, its claims must be handed back — and a block missing from
 * ONE apply (a transient store read, a race) must not hand a native field back
 * for good. So a release needs two consecutive applies to agree, exactly like
 * `WithdrawalGate` guards a composed device (D659).
 *
 * The gate is seeded at boot from the hub's claims index, so a restart is never
 * the first miss: an orphaned claim of a block that no longer exists is
 * released on the SECOND apply after boot, not the first, and not never.
 *
 * A release the hub did not confirm (a throw, an unreadable row, a migration in
 * flight) is retried on EVERY later apply until it lands — never on a timer
 * (D3), and never given up: a forgotten orphan claim would pin a stale composed
 * value on a native field until the composer restarts. Logged once per
 * transition (D391): a WARN when the failures start, an INFO naming the failed
 * attempts when it finally lands. This is also what heals a runtime whose own
 * `releaseClaim` on `disable()` failed: a disabled runtime runs no further pass
 * to re-send it (Task 8), the gate does.
 *
 * NOT the gate's: a FIELD released because its source is unavailable (S1b).
 * That is the runtime's `withhold`, immediate and reversible on the next event —
 * a source that blinked is not a withdrawal of the block's authority.
 */
import type { FieldClaim, IScopedLogger } from '@camstack/types'

export interface ClaimKey {
  readonly deviceId: number
  readonly capName: string
  readonly owner: string
}

export function claimKey(k: ClaimKey): string {
  return `${k.owner}@${k.deviceId}#${k.capName}`
}

const RELEASE_CONFIRMATIONS = 2

interface GateEntry {
  readonly key: ClaimKey
  /** Consecutive applies that did not want it. */
  readonly misses: number
  /** Release attempts the hub did not confirm. */
  readonly attempts: number
}

function entryOf(key: ClaimKey): GateEntry {
  return { key, misses: 0, attempts: 0 }
}

export class ClaimGate {
  private known: ReadonlyMap<string, GateEntry> = new Map()

  constructor(private readonly logger: IScopedLogger) {}

  /**
   * The claims the hub holds before this process applied anything. Called once
   * at boot, before the first `filter`. A claim the gate already knows keeps its
   * entry and its miss count.
   */
  seed(claims: readonly FieldClaim[]): void {
    const fresh = claims.filter((c) => !this.known.has(claimKey(c)))
    this.known = new Map([
      ...this.known,
      ...fresh.map(
        (c) =>
          [
            claimKey(c),
            entryOf({ deviceId: c.deviceId, capName: c.capName, owner: c.owner }),
          ] as const,
      ),
    ])
  }

  /** Every claim known under one owner — what a block whose plan is held keeps (D659 placeholder rule). */
  claimsOf(owner: string): readonly ClaimKey[] {
    return [...this.known.values()].filter((e) => e.key.owner === owner).map((e) => e.key)
  }

  /**
   * Learn `wanted` and answer the claims to release NOW: those absent from
   * `wanted` on two consecutive calls, plus those whose earlier release the hub
   * has not confirmed yet. A claim wanted again starts from zero misses.
   */
  filter(wanted: readonly ClaimKey[]): readonly ClaimKey[] {
    const present = new Map(wanted.map((k) => [claimKey(k), k] as const))
    const next = new Map<string, GateEntry>()
    const releases: ClaimKey[] = []
    for (const [key, entry] of this.known) {
      if (present.has(key)) {
        next.set(key, { ...entry, misses: 0, attempts: 0 })
        continue
      }
      const misses = Math.min(entry.misses + 1, RELEASE_CONFIRMATIONS)
      if (misses < RELEASE_CONFIRMATIONS) {
        this.logger.warn(
          'a claim vanished from one apply — it is kept until a second apply agrees',
          { tags: this.tagsOf(entry.key), meta: { ...this.metaOf(entry.key), misses } },
        )
      } else {
        if (entry.misses < RELEASE_CONFIRMATIONS) {
          this.logger.info(
            'a claim is unwanted on two consecutive applies — it is released to the native provider',
            { tags: this.tagsOf(entry.key), meta: this.metaOf(entry.key) },
          )
        }
        releases.push(entry.key)
      }
      next.set(key, { ...entry, misses })
    }
    for (const [key, k] of present) if (!next.has(key)) next.set(key, entryOf(k))
    this.known = next
    return releases
  }

  /** The hub confirmed the release (or held nothing of ours): forgotten. */
  released(key: ClaimKey, how: string): void {
    const k = claimKey(key)
    const attempts = this.known.get(k)?.attempts ?? 0
    this.known = new Map([...this.known].filter(([other]) => other !== k))
    this.logger.info(
      attempts > 0
        ? 'claim release landed after failed attempts'
        : 'claim release confirmed by the hub',
      {
        tags: this.tagsOf(key),
        meta: { ...this.metaOf(key), outcome: how, ...(attempts > 0 ? { attempts } : {}) },
      },
    )
  }

  /** The release did not land: kept, and returned by every later `filter` until it does. Never given up. */
  releaseFailed(key: ClaimKey, error: string): void {
    const k = claimKey(key)
    const entry = this.known.get(k)
    if (entry === undefined) return
    const attempts = entry.attempts + 1
    this.known = new Map([...this.known, [k, { ...entry, attempts }]])
    if (attempts > 1) return
    this.logger.warn('claim release did not land — retried on every apply until it does', {
      tags: this.tagsOf(key),
      meta: { ...this.metaOf(key), error },
    })
  }

  private tagsOf(key: ClaimKey): { readonly deviceId: number } {
    return { deviceId: key.deviceId }
  }

  private metaOf(key: ClaimKey): { readonly owner: string; readonly cap: string } {
    return { owner: key.owner, cap: key.capName }
  }
}
