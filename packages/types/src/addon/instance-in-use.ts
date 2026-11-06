/**
 * An instance is referenced by id and owns nothing of its users (D1012, D1013 rule 5). Removing
 * one that is still referenced is refused with an {@link InstanceInUseError} naming every user,
 * so the operator sees what to unlink first and nothing is left pointing at an instance that no
 * longer exists.
 */

import type { IIntegrationInstancesProvider } from '../capabilities/integration-instances.cap.js'

/** One thing that still points at an instance. */
export interface InstanceUser {
  /** What it is: `integration`, `notification-target`, ... */
  readonly kind: string
  readonly id: string
  readonly name?: string
}

/** Looks up one family of users of an instance. */
export interface InstanceUserFinder {
  find(instanceId: string): Promise<readonly InstanceUser[]>
}

export class InstanceInUseError extends Error {
  override readonly name = 'InstanceInUseError'

  constructor(
    readonly instanceId: string,
    readonly users: readonly InstanceUser[],
  ) {
    super(
      `instance '${instanceId}' is still in use by ${users
        .map((u) => `${u.kind} '${u.name ?? u.id}' (${u.id})`)
        .join(', ')}; unlink them first`,
    )
  }
}

/** Throw {@link InstanceInUseError} when any finder names a user of `instanceId`. */
export async function assertInstanceUnused(
  instanceId: string,
  finders: readonly InstanceUserFinder[],
): Promise<void> {
  const users: InstanceUser[] = []
  for (const finder of finders) users.push(...(await finder.find(instanceId)))
  if (users.length > 0) throw new InstanceInUseError(instanceId, users)
}

/** A row some other addon lists, with the form values it keeps its instance link in. */
export interface ListedFieldRow {
  readonly id: string
  readonly name?: string
  readonly formValues: Readonly<Record<string, unknown>>
}

function namesInstance(value: unknown, instanceId: string): boolean {
  if (Array.isArray(value)) return value.includes(instanceId)
  return value === instanceId
}

/**
 * Users reached through another addon's listed rows (an addon cannot read a record kind it does
 * not own): every row whose `field` holds the instance id, as a string or in a string list.
 * `list` is a cap call the owner serves.
 */
export function fieldUserFinder(spec: {
  readonly kind: string
  readonly field: string | readonly string[]
  readonly list: () => Promise<readonly ListedFieldRow[]>
}): InstanceUserFinder {
  const fields = typeof spec.field === 'string' ? [spec.field] : spec.field
  return {
    find: async (instanceId) =>
      (await spec.list())
        .filter((row) => fields.some((f) => namesInstance(row.formValues[f], instanceId)))
        .map((row) => ({
          kind: spec.kind,
          id: row.id,
          ...(row.name !== undefined ? { name: row.name } : {}),
        })),
  }
}

/**
 * A provider whose `deleteInstance` is refused while anything still uses the instance. The
 * account is an `integration-instances` kind (D1013), so the refusal lives on the delete the
 * instances page calls.
 */
export function guardInstanceDelete(
  base: IIntegrationInstancesProvider,
  users: () => readonly InstanceUserFinder[],
): IIntegrationInstancesProvider {
  return {
    ...base,
    deleteInstance: async (input) => {
      await assertInstanceUnused(input.id, users())
      return base.deleteInstance(input)
    },
  }
}
