import type { CoreBlock, IScopedLogger } from '@camstack/types'
import type { GroupTriggerSync } from './group-triggers.js'

/** What the enable switch needs of its host: the store write, the owned-block refusal and the converge. */
export interface SetBlockEnabledDeps {
  /** Throws when the block is an automation a group owns: it follows its group only. */
  readonly refuseIfOwned: (blockId: string) => void
  readonly update: (blockId: string, patch: { readonly enabled: boolean }) => Promise<CoreBlock>
  readonly convergeSoon: () => void
  /** Null before the group sync is armed. */
  readonly groupTriggers: () => GroupTriggerSync | null
  /** The device the block composes, when one is at hand: the tag a log line about it carries. */
  readonly deviceIdOf: (block: CoreBlock) => Promise<number | null>
  readonly logger: IScopedLogger
}

/**
 * The enable switch of a block. A group's off-switch reaches the automation its
 * triggers generate here, not at the next restart: the sync copies `group.enabled`
 * onto the owned block. A sync that fails is logged and does not undo the switch
 * the operator asked for; the next save or boot pass writes it.
 */
export async function setBlockEnabled(
  deps: SetBlockEnabledDeps,
  input: { readonly blockId: string; readonly enabled: boolean },
): Promise<{ readonly block: CoreBlock }> {
  deps.refuseIfOwned(input.blockId)
  const updated = await deps.update(input.blockId, { enabled: input.enabled })
  deps.convergeSoon()
  try {
    await deps.groupTriggers()?.sync(input.blockId, 'save')
  } catch (error: unknown) {
    const deviceId = await deps.deviceIdOf(updated).catch(() => null)
    deps.logger.warn('group triggers: the owned automation did not follow the enable switch', {
      ...(deviceId === null ? {} : { tags: { deviceId } }),
      meta: {
        blockId: input.blockId,
        enabled: input.enabled,
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }
  return { block: updated }
}
