/**
 * D944 + D984: a customize target's `apply` is `add`, except a `replace` the
 * cap itself allows. The cap lists a native field in `overridable` for ONE named
 * target (`{ path, by }`); a `replace` target is clean only when that entry
 * exists and names it, and an entry that names no replace target is a violation
 * too. No cap is named here: the allow-list is the cap's own declaration.
 */

export interface CustomizeApplyTarget {
  readonly id: string
  readonly apply: string
  readonly path?: string
}

export interface CustomizeApplyOverridable {
  readonly path: string
  readonly by: string
}

export interface CustomizeApplyCap {
  readonly capName: string
  readonly targets: readonly CustomizeApplyTarget[]
  readonly overridable?: readonly CustomizeApplyOverridable[]
}

function replaceViolation(cap: CustomizeApplyCap, target: CustomizeApplyTarget): string | null {
  const allowed = (cap.overridable ?? []).some(
    (row) => row.by === target.id && row.path === target.path,
  )
  if (target.apply === 'replace') {
    return allowed
      ? null
      : `${cap.capName}.${target.id} apply is 'replace' but the cap does not list it in overridable (D984)`
  }
  return `${cap.capName}.${target.id} apply is '${target.apply}' — D944 allows only 'add' (and the 'replace' a cap declares overridable, D984)`
}

function dangling(cap: CustomizeApplyCap): readonly string[] {
  return (cap.overridable ?? []).flatMap((row) => {
    const target = cap.targets.find((candidate) => candidate.id === row.by)
    if (target !== undefined && target.apply === 'replace' && target.path === row.path) return []
    return [
      `${cap.capName} overridable ${row.path} by ${row.by} names no replace target on that path (D984)`,
    ]
  })
}

export function customizeApplyViolations(caps: readonly CustomizeApplyCap[]): readonly string[] {
  const violations: string[] = []
  for (const cap of caps) {
    for (const target of cap.targets) {
      if (target.apply === 'add') continue
      const found = replaceViolation(cap, target)
      if (found !== null) violations.push(found)
    }
    violations.push(...dangling(cap))
  }
  return violations
}
