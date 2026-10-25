/**
 * D4 — capability metadata cross-check.
 *
 * The `*.cap.ts` `CapabilityDefinition` is the single source of truth for
 * `kind` / `defaultActive`. The runtime `ProviderRegistration.kind` /
 * `defaultActive` survive only as deprecated optional hints. When an addon
 * still sets a hint and it disagrees with the cap definition, the kernel
 * logs this warning — the cap definition always wins.
 */
import type { CapabilityDefinition } from '@camstack/types'

/** The deprecated runtime metadata hint carried on a `ProviderRegistration`. */
export type ProviderKindHint = {
  readonly kind?: 'native' | 'wrapper'
  readonly defaultActive?: boolean
}

/**
 * Compare a runtime registration hint against the authoritative cap
 * definition. Returns a human-readable warning string when they disagree,
 * or `null` when the hint is absent or consistent.
 */
export function describeProviderKindDrift(
  capName: string,
  capDef: Pick<CapabilityDefinition, 'kind' | 'defaultActive'>,
  hint: ProviderKindHint,
): string | null {
  const defKind = capDef.kind ?? 'native'
  const defDefaultActive = capDef.defaultActive ?? false
  const issues: string[] = []

  if (hint.kind !== undefined && hint.kind !== defKind) {
    issues.push(`kind hint '${hint.kind}' vs cap definition '${defKind}'`)
  }
  if (hint.defaultActive !== undefined && hint.defaultActive !== defDefaultActive) {
    issues.push(
      `defaultActive hint '${hint.defaultActive}' vs cap definition '${defDefaultActive}'`,
    )
  }

  if (issues.length === 0) return null
  return (
    `Capability '${capName}': ProviderRegistration metadata disagrees with the ` +
    `cap definition — the cap definition wins (D4). ${issues.join('; ')}`
  )
}
