/**
 * Describe-only ship plan for capability changes.
 * Never publishes, deploys, or mutates the hub.
 */

export type ShipChangeKind = 'new-cap' | 'new-method' | 'additive-field' | 'auth-tier' | 'unknown'

export interface CapShipPlan {
  readonly changedCaps: readonly string[]
  readonly kind: ShipChangeKind
  readonly forcePublishSystem: boolean
  readonly steps: readonly string[]
  readonly notes: readonly string[]
}

export function capShipPlan(
  changedCaps: readonly string[],
  kind: ShipChangeKind = 'unknown',
): CapShipPlan {
  const caps = changedCaps.map((c) => c.trim()).filter(Boolean)
  const forcePublishSystem = kind === 'new-cap' || kind === 'new-method' || kind === 'unknown'

  const steps: string[] = []
  const notes: string[] = [
    'Description only — camstack-dev never runs publish/deploy.',
    'Never dispatch .github/workflows/checks.yml from an agent (it can kill agent-a).',
  ]

  if (kind === 'additive-field') {
    steps.push(
      'Redeploy the providing addon only (no force-publish of @camstack/system required).',
      'Verify the new field on a live node.',
    )
    notes.push('Additive fields are cheap: contract shape grows, routers stay compatible.')
  } else {
    steps.push(
      'Publish through CI (force-publish @camstack/system when the contract changed).',
      'applyServerUpdate on the hub.',
      'Deploy builtins + packages/system addon.',
      'Verify hub pid and that capabilities re-registered (Deploy ≠ capabilities re-registered).',
      '+1 restart and toggle-verify the new/changed surface.',
    )
    if (kind === 'new-method' || kind === 'new-cap') {
      notes.push(
        'A new method/cap is a framework change: published @camstack/server reaches nodes only after the train.',
      )
    }
    if (kind === 'auth-tier') {
      notes.push('Review method-tiers baseline diff for WIDENED lines before merging.')
      steps.unshift(
        'npx tsx scripts/check-method-tiers.ts --update (commit the baseline deliberately)',
      )
    }
  }

  if (caps.length > 0) {
    notes.push(`Caps in scope: ${caps.join(', ')}`)
  }

  return {
    changedCaps: caps,
    kind,
    forcePublishSystem,
    steps,
    notes,
  }
}
