/**
 * The automations made from a template (#527), found and re-expanded where they
 * live: the core-block store. An instance is a block whose recipe literal links
 * to the template (`AutomationRecipe.template`) — there is no second list of
 * instances to keep in step with the blocks.
 *
 * When a template is saved, every instance is re-expanded with its stored
 * values through the same pure function the editor uses, and its code is
 * regenerated and saved through the ordinary block update (compile gate,
 * converge). An instance whose values no longer fit keeps its last good body
 * and is flagged on its link; it is never dropped and never left silent.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  capUnitResolver,
  generateAutomationBlock,
  prepareRecipeUnits,
  readRecipeLiteral,
  reexpandAutomationInstance,
  type AutomationTemplatePayload,
  type CoreBlock,
  type IScopedLogger,
  type TemplateAutomationUser,
  type UnitResolver,
} from '@camstack/types'

export interface AutomationTemplateInstances {
  /** The automations whose recipe links to the template. */
  using(templateId: string): Promise<readonly TemplateAutomationUser[]>
  /** Re-expand every instance of the template against its new payload. */
  reexpand(templateId: string, payload: AutomationTemplatePayload): Promise<ReexpandReport>
}

export interface ReexpandReport {
  readonly updated: number
  readonly flagged: number
  readonly failed: number
}

export interface AutomationTemplateInstancesDeps {
  readonly blocks: () => readonly CoreBlock[]
  /** The ordinary block update: compile gate, store, converge. */
  readonly saveCode: (blockId: string, code: string) => Promise<void>
  readonly logger: IScopedLogger
  /** The cap unit knowledge the editor stamps a recipe with before codegen. */
  readonly units?: UnitResolver
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function automationTemplateInstancesOver(
  deps: AutomationTemplateInstancesDeps,
): AutomationTemplateInstances {
  const units = deps.units ?? capUnitResolver(ALL_CAPABILITY_DEFINITIONS)
  const instancesOf = (templateId: string) =>
    deps.blocks().flatMap((block) => {
      const read = readRecipeLiteral(block.code)
      if (read.status !== 'recipe' || read.recipe.template?.templateId !== templateId) return []
      return [{ block, recipe: read.recipe }]
    })

  return {
    using: async (templateId) =>
      instancesOf(templateId).map(({ block }) => ({ blockId: block.id, name: block.name })),

    reexpand: async (templateId, payload) => {
      let updated = 0
      let flagged = 0
      let failed = 0
      for (const { block, recipe } of instancesOf(templateId)) {
        const next = reexpandAutomationInstance(payload, recipe)
        const prepared = prepareRecipeUnits(next.recipe, units)
        if (!prepared.ok) {
          failed += 1
          deps.logger.warn(
            'automation template: an instance could not be prepared, left as it was',
            {
              meta: { templateId, blockId: block.id, error: prepared.error },
            },
          )
          continue
        }
        try {
          await deps.saveCode(
            block.id,
            generateAutomationBlock({ name: block.name, recipe: prepared.recipe }),
          )
        } catch (error: unknown) {
          failed += 1
          deps.logger.warn('automation template: an instance could not be saved, left as it was', {
            meta: { templateId, blockId: block.id, error: errorText(error) },
          })
          continue
        }
        if (next.flagged) {
          flagged += 1
          deps.logger.warn(
            'automation template: an instance no longer fits the template, its last body is kept and it is flagged',
            {
              meta: {
                templateId,
                blockId: block.id,
                problems: next.recipe.template?.problems?.map((p) => p.detail),
              },
            },
          )
        } else {
          updated += 1
        }
      }
      deps.logger.info('automation template: instances re-expanded', {
        meta: { templateId, updated, flagged, failed },
      })
      return { updated, flagged, failed }
    },
  }
}
