/**
 * core-blocks' `device-removal-hook` (D865, #706): a deleted device takes with
 * it the blocks that only existed for it.
 *
 * - A composition that OWNS the device (its composed device) is retired through
 *   the same path an operator delete takes (`removeBlock` → `retireComposition`).
 *   The tombstone carries no stableId, so the owner is found in an index of
 *   `deviceId → block id` fed ONLY by positive reads of the composer's devices
 *   (never by absence from a list, D865).
 * - A `builtin:linked-trigger` block REFERENCES devices (its target and its
 *   sources, stored in the template values). A reference to the deleted device is
 *   dropped; a block left with nothing to act on (its target is gone, or no
 *   source remains) is deleted; a block that still has live references is
 *   regenerated without the dead one and never deleted.
 *
 * Idempotent: a second run finds nothing referencing the device.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  builtinAutomationTemplate,
  capUnitResolver,
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  generateAutomationBlock,
  LINKED_TRIGGER_TARGET_INPUT,
  LINKED_TRIGGER_TEMPLATE_ID,
  linkedTriggerParamsOf,
  linkedTriggerValues,
  prepareRecipeUnits,
  readRecipeLiteral,
  reexpandAutomationInstance,
  type AutomationRecipe,
  type CoreBlock,
  type DeviceDataEntry,
  type DeviceRemovedInput,
  type DeviceRemovedResult,
  type IDeviceRemovalHookProvider,
  type IScopedLogger,
  type LinkedTriggerSource,
  type UnitResolver,
} from '@camstack/types'
import { isGeneratedCode } from './automation-template-instances.js'

/** `deviceId → composition block id`, grown from reads that SAW the device. */
export class ComposedDeviceIndex {
  private readonly byDevice = new Map<number, string>()

  learn(rows: readonly { readonly id: number; readonly stableId: string }[]): void {
    for (const row of rows) {
      if (!row.stableId.startsWith(COMPOSED_DEVICE_STABLE_ID_PREFIX)) continue
      this.byDevice.set(row.id, row.stableId.slice(COMPOSED_DEVICE_STABLE_ID_PREFIX.length))
    }
  }

  blockOf(deviceId: number): string | null {
    return this.byDevice.get(deviceId) ?? null
  }

  forget(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }

  entries(): readonly (readonly [number, string])[] {
    return [...this.byDevice]
  }
}

export interface CoreBlocksRemovalDeps {
  readonly blocks: () => readonly CoreBlock[]
  readonly composed: ComposedDeviceIndex
  /** The operator's delete path: records, claims, `retireComposition`. */
  readonly removeBlock: (blockId: string, existing: CoreBlock) => Promise<void>
  /** The ordinary block update: compile gate, store, converge. */
  readonly saveCode: (blockId: string, code: string) => Promise<void>
  readonly logger: IScopedLogger
  readonly units?: UnitResolver
}

interface LinkedRefs {
  readonly block: CoreBlock
  readonly recipe: AutomationRecipe
  readonly targetId: unknown
  readonly sources: readonly LinkedTriggerSource[] | null
}

function sourceDeviceIds(source: LinkedTriggerSource): readonly number[] {
  return source.kind === 'detection' ? source.deviceIds : [source.deviceId]
}

/** The source without the dead device; null when nothing of it remains. */
function withoutDevice(source: LinkedTriggerSource, deviceId: number): LinkedTriggerSource | null {
  if (source.kind !== 'detection') return source.deviceId === deviceId ? null : source
  const ids = source.deviceIds.filter((id) => id !== deviceId)
  return ids.length === 0 ? null : { ...source, deviceIds: ids }
}

function linkedTriggers(blocks: readonly CoreBlock[]): readonly LinkedRefs[] {
  return blocks.flatMap((block) => {
    const read = readRecipeLiteral(block.code)
    if (read.status !== 'recipe') return []
    const link = read.recipe.template
    if (link === undefined || link.templateId !== LINKED_TRIGGER_TEMPLATE_ID) return []
    const params = linkedTriggerParamsOf(link.values)
    return [
      {
        block,
        recipe: read.recipe,
        targetId: link.values[LINKED_TRIGGER_TARGET_INPUT],
        sources: params === null ? null : params.sources,
      },
    ]
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createCoreBlocksRemovalHook(
  deps: CoreBlocksRemovalDeps,
): IDeviceRemovalHookProvider {
  const units = deps.units ?? capUnitResolver(ALL_CAPABILITY_DEFINITIONS)

  const rewrite = async (
    ref: LinkedRefs,
    sources: readonly LinkedTriggerSource[],
  ): Promise<void> => {
    const link = ref.recipe.template
    const params = link === undefined ? null : linkedTriggerParamsOf(link.values)
    const payload = builtinAutomationTemplate(LINKED_TRIGGER_TEMPLATE_ID)?.payload ?? null
    if (link === undefined || params === null || payload === null) {
      throw new Error('the linked trigger cannot be read back')
    }
    const values = linkedTriggerValues({ ...params, sources: [...sources] })
    const next = reexpandAutomationInstance(payload, {
      ...ref.recipe,
      template: { ...link, values },
    })
    const prepared = prepareRecipeUnits(next.recipe, units)
    if (!prepared.ok) throw new Error(prepared.error)
    await deps.saveCode(
      ref.block.id,
      generateAutomationBlock({ name: ref.block.name, recipe: prepared.recipe }),
    )
  }

  return {
    onDeviceRemoved: async (input: DeviceRemovedInput): Promise<DeviceRemovedResult> => {
      const { deviceId } = input
      let compositions = 0
      let automationsDeleted = 0
      let automationsUnlinked = 0

      const ownedId = deps.composed.blockOf(deviceId)
      if (ownedId !== null) {
        const owned = deps.blocks().find((b) => b.id === ownedId) ?? null
        if (owned !== null) {
          await deps.removeBlock(owned.id, owned)
          compositions += 1
          deps.logger.info('core-blocks: retired the composition of a deleted device', {
            tags: { deviceId },
            meta: { blockId: owned.id },
          })
        }
        deps.composed.forget(deviceId)
      }

      for (const ref of linkedTriggers(deps.blocks())) {
        const blockId = ref.block.id
        const targetGone = ref.targetId === deviceId
        const kept =
          ref.sources === null
            ? null
            : ref.sources.flatMap((s) => {
                const left = withoutDevice(s, deviceId)
                return left === null ? [] : [left]
              })
        const referencesSource =
          ref.sources !== null && ref.sources.some((s) => sourceDeviceIds(s).includes(deviceId))
        if (!targetGone && !referencesSource) continue
        if (targetGone || (kept !== null && kept.length === 0)) {
          await deps.removeBlock(blockId, ref.block)
          automationsDeleted += 1
          deps.logger.info('core-blocks: deleted a trigger with nothing left to act on', {
            tags: { deviceId },
            meta: { blockId, reason: targetGone ? 'target-deleted' : 'last-source-deleted' },
          })
          continue
        }
        if (kept === null || !isGeneratedCode(ref.block.code, ref.recipe)) {
          deps.logger.warn(
            'core-blocks: a trigger still lists a deleted device and was left as it is (hand-edited or unreadable)',
            { tags: { deviceId }, meta: { blockId } },
          )
          continue
        }
        try {
          await rewrite(ref, kept)
          automationsUnlinked += 1
          deps.logger.info('core-blocks: unlinked a deleted device from a trigger', {
            tags: { deviceId },
            meta: { blockId, remainingSources: kept.length },
          })
        } catch (error: unknown) {
          deps.logger.warn('core-blocks: a trigger could not be unlinked from a deleted device', {
            tags: { deviceId },
            meta: { blockId, error: errorText(error) },
          })
          throw error
        }
      }
      return {
        counts: {
          compositions,
          'automations-deleted': automationsDeleted,
          'automations-unlinked': automationsUnlinked,
        },
      }
    },
    listDeviceData: async (): Promise<readonly DeviceDataEntry[]> => {
      const counts = new Map<number, number>()
      for (const ref of linkedTriggers(deps.blocks())) {
        const ids = [
          ...(typeof ref.targetId === 'number' ? [ref.targetId] : []),
          ...(ref.sources ?? []).flatMap(sourceDeviceIds),
        ]
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      const out: DeviceDataEntry[] = []
      for (const [deviceId, count] of counts) {
        if (deviceId > 0) out.push({ store: 'automations', deviceId, count })
      }
      for (const [deviceId] of deps.composed.entries()) {
        out.push({ store: 'compositions', deviceId, count: 1 })
      }
      return out
    },
  }
}
