/**
 * The one writer of the automation blocks an actuator group owns. A group's
 * triggers live in its helper spec; here they are compiled (`groupTriggerRecipe`)
 * into ONE automation block carrying `ownedBy: { kind: 'group', blockId }`.
 *
 * The block is regenerated on every save of the group and at boot, so it never
 * drifts from the spec, and every other writer is refused (`ownedGroupOf`).
 * Nothing here decides what a trigger means: that is the pure generator's.
 *
 * What it will not do (D49): destroy on a read that may be incomplete. The
 * owned block is deleted only when the group has no enabled trigger left or
 * the group itself is gone from the loaded store; a trigger whose device could
 * not be found at BOOT keeps the block as it is (the device list may be
 * partial then), while an operator's save writes what resolves and names what
 * was left out.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  capUnitResolver,
  composedDeviceStableId,
  coreBlockComposition,
  generateAutomationBlock,
  groupTriggerRecipe,
  prepareRecipeUnits,
  readRecipeLiteral,
  type AutomationRecipe,
  type CompositionSourceRef,
  type CoreBlock,
  type CoreBlockInput,
  type GroupHelperSpec,
  type IScopedLogger,
  type UnitResolver,
} from '@camstack/types'

/** What the sync reads of the store. */
export interface GroupTriggerBlocks {
  /** False until the table has been READ: an empty list then proves nothing. */
  isLoaded(): boolean
  list(): readonly CoreBlock[]
  get(blockId: string): CoreBlock | null
}

/** The fields a sync writes onto the owned block. */
export interface OwnedBlockWrite {
  readonly name: string
  readonly code: string
  readonly enabled: boolean
}

/** The ordinary block writes (compile gate, store, converge) — injected, so this file never touches the store. */
export interface GroupTriggerWrites {
  create(input: CoreBlockInput): Promise<void>
  save(blockId: string, write: OwnedBlockWrite): Promise<void>
  remove(blockId: string): Promise<void>
}

export interface GroupTriggerSyncDeps {
  readonly blocks: GroupTriggerBlocks
  readonly writes: GroupTriggerWrites
  /** `addonId/stableId` → device id. A rejection means the answer is unknown: nothing is written. */
  readonly deviceIds: () => Promise<ReadonlyMap<string, number>>
  readonly logger: IScopedLogger
  readonly units?: UnitResolver
}

/** `save`: an operator's write, applied as it resolves. `boot`: a pass over what is stored. */
export type GroupSyncMode = 'save' | 'boot'

export type GroupSyncOutcome =
  | 'written'
  | 'unchanged'
  | 'removed'
  /** The group still has triggers but some could not be resolved at boot: the block is left as it is. */
  | 'kept'
  | 'skipped'

export interface GroupTriggerSync {
  sync(groupBlockId: string, mode: GroupSyncMode): Promise<GroupSyncOutcome>
  /** The group block was deleted: its owned block goes with it. */
  remove(groupBlockId: string): Promise<void>
  /**
   * Boot: every group with triggers, and every owned block whose group is gone.
   * True once the pass could read the devices; false when it could not run (then it is tried again).
   */
  reconcile(): Promise<boolean>
  /**
   * A device registered: a group that has enabled triggers and no owned block yet
   * (its own device was not built when it was saved) is synced now. Nothing is
   * read when no group waits, and a pass in flight is joined, never doubled.
   */
  wake(): Promise<void>
}

/** The group a block is owned by, or null for any other block. */
export function ownedGroupOf(block: CoreBlock): string | null {
  const read = readRecipeLiteral(block.code)
  if (read.status !== 'recipe') return null
  return read.recipe.ownedBy?.blockId ?? null
}

export function ownedRefusal(groupBlockId: string, group: CoreBlock | null): string {
  const name = group === null ? groupBlockId : group.name
  return `core-blocks: this automation is managed by the group "${name}" — change its triggers there`
}

function keyOf(ref: CompositionSourceRef): string {
  return `${ref.addonId}/${ref.stableId}`
}

function groupSpecOf(block: CoreBlock): GroupHelperSpec | null {
  const helper = coreBlockComposition(block)?.helper
  return helper?.kind === 'group' ? helper : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ownedName(group: CoreBlock): string {
  return `${group.name} — triggers`
}

export function groupTriggerSyncOver(deps: GroupTriggerSyncDeps): GroupTriggerSync {
  const units = deps.units ?? capUnitResolver(ALL_CAPABILITY_DEFINITIONS)
  const ownedBlocks = (groupBlockId: string): readonly CoreBlock[] =>
    deps.blocks.list().filter((block) => ownedGroupOf(block) === groupBlockId)

  const removeOwned = async (groupBlockId: string): Promise<boolean> => {
    const owned = ownedBlocks(groupBlockId)
    for (const block of owned) await deps.writes.remove(block.id)
    return owned.length > 0
  }

  const write = async (
    group: CoreBlock,
    recipe: AutomationRecipe,
  ): Promise<'written' | 'unchanged'> => {
    const prepared = prepareRecipeUnits(recipe, units)
    if (!prepared.ok) throw new Error(prepared.error)
    const name = ownedName(group)
    const code = generateAutomationBlock({ name, recipe: prepared.recipe })
    const [current, ...extra] = ownedBlocks(group.id)
    for (const duplicate of extra) await deps.writes.remove(duplicate.id)
    if (current === undefined) {
      await deps.writes.create({ name, code, enabled: group.enabled, placement: group.placement })
      return 'written'
    }
    if (current.code === code && current.name === name && current.enabled === group.enabled) {
      return 'unchanged'
    }
    await deps.writes.save(current.id, { name, code, enabled: group.enabled })
    return 'written'
  }

  const syncOne = async (groupBlockId: string, mode: GroupSyncMode): Promise<GroupSyncOutcome> => {
    if (!deps.blocks.isLoaded()) return 'skipped'
    const group = deps.blocks.get(groupBlockId)
    const spec = group === null ? null : groupSpecOf(group)
    if (group === null || spec === null) {
      return (await removeOwned(groupBlockId)) ? 'removed' : 'unchanged'
    }
    if ((spec.triggers ?? []).every((trigger) => trigger.enabled === false)) {
      return (await removeOwned(groupBlockId)) ? 'removed' : 'unchanged'
    }
    let ids: ReadonlyMap<string, number>
    try {
      ids = await deps.deviceIds()
    } catch (error: unknown) {
      deps.logger.warn('group triggers: devices could not be read, the block is left as it is', {
        meta: { blockId: groupBlockId, error: errorText(error) },
      })
      return 'skipped'
    }
    const made = groupTriggerRecipe({
      blockId: groupBlockId,
      helper: spec,
      resolve: (ref) => ids.get(keyOf(ref)) ?? null,
    })
    const groupDeviceId = ids.get(
      keyOf({ addonId: 'composer', stableId: composedDeviceStableId(groupBlockId) }),
    )
    for (const left of made.leftOut) {
      deps.logger.warn('group triggers: a trigger was left out', {
        ...(groupDeviceId === undefined ? {} : { tags: { deviceId: groupDeviceId } }),
        meta: { blockId: groupBlockId, trigger: left.triggerId, reason: left.reason },
      })
    }
    if (made.recipe === null || (mode === 'boot' && made.leftOut.length > 0)) {
      return 'kept'
    }
    return write(group, made.recipe)
  }

  const waiting = (): readonly CoreBlock[] =>
    deps.blocks.isLoaded()
      ? deps.blocks.list().filter((block) => {
          const spec = groupSpecOf(block)
          return (
            spec !== null &&
            (spec.triggers ?? []).some((trigger) => trigger.enabled !== false) &&
            ownedBlocks(block.id).length === 0
          )
        })
      : []
  let wakePass: Promise<void> | null = null

  return {
    wake: () => {
      if (wakePass !== null) return wakePass
      if (waiting().length === 0) return Promise.resolve()
      const pass = (async (): Promise<void> => {
        for (const group of waiting()) {
          try {
            await syncOne(group.id, 'save')
          } catch (error: unknown) {
            deps.logger.error('group triggers: the wake pass failed for a group', {
              meta: { blockId: group.id, error: errorText(error) },
            })
          }
        }
      })().finally(() => {
        wakePass = null
      })
      wakePass = pass
      return pass
    },

    sync: async (groupBlockId, mode) => {
      try {
        return await syncOne(groupBlockId, mode)
      } catch (error: unknown) {
        deps.logger.error('group triggers: the automation could not be written', {
          meta: { blockId: groupBlockId, mode, error: errorText(error) },
        })
        throw error
      }
    },

    remove: async (groupBlockId) => {
      await removeOwned(groupBlockId)
    },

    reconcile: async () => {
      if (!deps.blocks.isLoaded()) return false
      try {
        await deps.deviceIds()
      } catch (error: unknown) {
        deps.logger.warn('group triggers: the boot pass waits for the device list', {
          meta: { error: errorText(error) },
        })
        return false
      }
      const blocks = deps.blocks.list()
      const groups = blocks.filter((block) => groupSpecOf(block) !== null)
      const orphans = new Set(
        blocks.flatMap((block) => {
          const owner = ownedGroupOf(block)
          return owner === null || groups.some((group) => group.id === owner) ? [] : [owner]
        }),
      )
      for (const group of groups) {
        try {
          await syncOne(group.id, 'boot')
        } catch (error: unknown) {
          deps.logger.error('group triggers: boot pass failed for a group', {
            meta: { blockId: group.id, error: errorText(error) },
          })
        }
      }
      for (const owner of orphans) {
        // The group is absent from the LOADED store: nothing reads it back, so its block goes.
        if (deps.blocks.get(owner) !== null) continue
        await removeOwned(owner)
      }
      return true
    },
  }
}
