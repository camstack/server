/**
 * D944: a customize target's `apply` is `add`. The type says so; this walks
 * the loaded declarations so a widened apply fails the Checks workflow.
 */

export interface CustomizeApplyTarget {
  readonly id: string
  readonly apply: string
}

export interface CustomizeApplyCap {
  readonly capName: string
  readonly targets: readonly CustomizeApplyTarget[]
}

const ALLOWED: readonly { readonly cap: string; readonly targetId: string }[] = []

export function customizeApplyViolations(caps: readonly CustomizeApplyCap[]): readonly string[] {
  const violations: string[] = []
  for (const cap of caps) {
    for (const target of cap.targets) {
      if (target.apply === 'add') continue
      const allowed = ALLOWED.some((row) => row.cap === cap.capName && row.targetId === target.id)
      if (allowed) continue
      violations.push(
        `${cap.capName}.${target.id} apply is '${target.apply}' — D944 allows only 'add'`,
      )
    }
  }
  return violations
}
