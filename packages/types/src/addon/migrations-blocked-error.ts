/**
 * An addon whose own migrations did not apply refuses to initialise (D987). The error is typed
 * so a runner hosting several addons can tell "this addon is blocked" from a crash and keep its
 * co-located siblings running. Recognised by NAME and shape, never `instanceof`: a forked addon
 * bundles its own copy of this module, so the class the runner sees is not the one that threw.
 */
export const MIGRATIONS_BLOCKED_ERROR_NAME = 'AddonMigrationsBlockedError'

export class AddonMigrationsBlockedError extends Error {
  /** The ledger ids that did not apply and block the owner. */
  readonly migrationIds: readonly string[]

  constructor(migrationIds: readonly string[]) {
    super(
      `migration(s) ${migrationIds.join(', ')} did not apply and block this addon — fix or retry them (migrations.retry), then restart it`,
    )
    this.name = MIGRATIONS_BLOCKED_ERROR_NAME
    this.migrationIds = migrationIds
  }
}

function idsOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    ids.push(item)
  }
  return ids
}

/** The migration ids a blocked-owner error in `err`'s cause chain names; null when it is none. */
export function findMigrationsBlocked(err: unknown): readonly string[] | null {
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current instanceof Error && !seen.has(current)) {
    if (current.name === MIGRATIONS_BLOCKED_ERROR_NAME) {
      const ids = idsOf(Reflect.get(current, 'migrationIds'))
      if (ids !== null) return ids
    }
    seen.add(current)
    current = current.cause
  }
  return null
}
