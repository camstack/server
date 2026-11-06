/**
 * @deprecated The broker-named spellings of `instance-in-use.ts` (D1013); consumers move to the
 * instance names in steps B2-B7 and this file is deleted in B8.
 */
import type { IIntegrationInstancesProvider } from '../capabilities/integration-instances.cap.js'
import {
  assertInstanceUnused,
  fieldUserFinder,
  InstanceInUseError,
  type InstanceUser,
  type InstanceUserFinder,
} from './instance-in-use.js'

export type { ListedFieldRow } from './instance-in-use.js'
export { fieldUserFinder }

/** @deprecated use {@link InstanceUser}. */
export type BrokerUser = InstanceUser
/** @deprecated use {@link InstanceUserFinder}. */
export type BrokerUserFinder = InstanceUserFinder

/** @deprecated use {@link InstanceInUseError}; this one only adds the old `brokerId` name. */
export class BrokerInUseError extends InstanceInUseError {
  get brokerId(): string {
    return this.instanceId
  }
}

/** @deprecated use {@link assertInstanceUnused}. */
export async function assertBrokerUnused(
  brokerId: string,
  finders: readonly BrokerUserFinder[],
): Promise<void> {
  try {
    await assertInstanceUnused(brokerId, finders)
  } catch (err: unknown) {
    if (err instanceof InstanceInUseError) throw new BrokerInUseError(err.instanceId, err.users)
    throw err
  }
}

/** @deprecated use `guardInstanceDelete`. */
export function guardBrokerDelete(
  base: IIntegrationInstancesProvider,
  users: () => readonly BrokerUserFinder[],
): IIntegrationInstancesProvider {
  return {
    ...base,
    deleteInstance: async (input) => {
      await assertBrokerUnused(input.id, users())
      return base.deleteInstance(input)
    },
  }
}
