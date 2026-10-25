/**
 * Pure boot-plan decision for the server-root starter — ZERO-DEP.
 *
 * Single-copy model (2026-07-18 collapse): the swap + migration have already
 * run by the time this is consulted, so the decision reduces to "is the ONE
 * canonical `current/` closure present and valid?". If yes → boot it; if no
 * (fresh install, or a corrupt/absent copy) → boot the baked image seed.
 *
 * The probation / auto-rollback / N-1 / baked-seed-adoption machinery of the
 * legacy multi-copy model is GONE: there is no second copy to compare against
 * or roll back to (operator's accepted tradeoff — manual recovery only).
 *
 * Spec: docs/superpowers/specs/2026-07-18-single-framework-copy-collapse-design.md
 */

export type BootPlan =
  | { readonly kind: 'current'; readonly reason: string }
  | { readonly kind: 'baked'; readonly reason: string }

/**
 * Decide the boot target from a single boolean: whether the canonical
 * `current/` closure validated. Never throws.
 */
export function planBoot(currentValid: boolean): BootPlan {
  if (currentValid) {
    return { kind: 'current', reason: 'single-copy closure present and valid' }
  }
  return { kind: 'baked', reason: 'no valid single-copy closure — booting the baked seed' }
}
