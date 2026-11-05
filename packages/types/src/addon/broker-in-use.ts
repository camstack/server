/**
 * A broker is referenced by id and owns nothing of its users (D1011). Removing one that is still
 * referenced is refused with a {@link BrokerInUseError} naming every user, so the operator sees
 * what to unlink first and nothing is left pointing at a broker that no longer exists.
 */

/** One thing that still points at a broker. */
export interface BrokerUser {
  /** What it is: `integration`, `notification-target`, ... */
  readonly kind: string
  readonly id: string
  readonly name?: string
}

/** Looks up one family of users of a broker. */
export interface BrokerUserFinder {
  find(brokerId: string): Promise<readonly BrokerUser[]>
}

export class BrokerInUseError extends Error {
  override readonly name = 'BrokerInUseError'

  constructor(
    readonly brokerId: string,
    readonly users: readonly BrokerUser[],
  ) {
    super(
      `broker '${brokerId}' is still in use by ${users
        .map((u) => `${u.kind} '${u.name ?? u.id}' (${u.id})`)
        .join(', ')}; unlink them first`,
    )
  }
}

/** Throw {@link BrokerInUseError} when any finder names a user of `brokerId`. */
export async function assertBrokerUnused(
  brokerId: string,
  finders: readonly BrokerUserFinder[],
): Promise<void> {
  const users: BrokerUser[] = []
  for (const finder of finders) users.push(...(await finder.find(brokerId)))
  if (users.length > 0) throw new BrokerInUseError(brokerId, users)
}

/** A row some other addon lists, with the form values it keeps its broker link in. */
export interface ListedFieldRow {
  readonly id: string
  readonly name?: string
  readonly formValues: Readonly<Record<string, unknown>>
}

/**
 * Users reached through another addon's listed rows (an addon cannot read a record kind it does
 * not own): every row whose `field` holds the broker id. `list` is a cap call the owner serves.
 */
export function fieldUserFinder(spec: {
  readonly kind: string
  readonly field: string
  readonly list: () => Promise<readonly ListedFieldRow[]>
}): BrokerUserFinder {
  return {
    find: async (brokerId) =>
      (await spec.list())
        .filter((row) => row.formValues[spec.field] === brokerId)
        .map((row) => ({
          kind: spec.kind,
          id: row.id,
          ...(row.name !== undefined ? { name: row.name } : {}),
        })),
  }
}
