/**
 * Whether a live track is motion inside a configured package drop-off zone.
 *
 * The stillness activity gate used to stamp ANY non-package track on the
 * camera. A walker at the far gate then "delivered" the streetlight wedge
 * on the doormat. The operator's prerequisite is motion in the drop-off
 * zone the package rule points at — the same zones `PackageDropDetector`
 * uses for the centroid gate.
 */
export function isDelivererInPackageZone(
  trackZones: readonly string[],
  packageZoneIds: ReadonlySet<string>,
): boolean {
  if (packageZoneIds.size === 0 || trackZones.length === 0) return false
  for (const z of trackZones) {
    if (packageZoneIds.has(z)) return true
  }
  return false
}

export interface PackageZoneRuleLike {
  readonly enabled?: boolean
  readonly zoneIds: readonly string[]
}

export interface PackageOptionRule extends PackageZoneRuleLike {
  readonly detectBySceneDifference?: boolean
  readonly confirmWithLlm?: boolean
}

/** Zone ids of enabled package rules that turned one option on. */
export function packageRuleZoneIds(
  rules: readonly PackageOptionRule[],
  flag: 'detectBySceneDifference' | 'confirmWithLlm',
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const rule of rules) {
    if (rule.enabled === false) continue
    const on =
      flag === 'detectBySceneDifference'
        ? rule.detectBySceneDifference === true
        : rule.confirmWithLlm === true
    if (!on) continue
    for (const zoneId of rule.zoneIds) ids.add(zoneId)
  }
  return ids
}

/** Zone ids referenced by enabled `package`-stage rules. Disabled rules do not count. */
export function collectPackageZoneIds(rules: readonly PackageZoneRuleLike[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const r of rules) {
    if (r.enabled === false) continue
    for (const z of r.zoneIds) ids.add(z)
  }
  return ids
}
