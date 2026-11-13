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
 *
 * A block whose code was edited outside the generator (its fingerprint no
 * longer matches `template.codeHash`) is never regenerated over: only its
 * literal is rewritten, to flag it `edited-by-hand`.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  capUnitResolver,
  generateAutomationBlock,
  instanceCodeHash,
  prepareRecipeUnits,
  readRecipeLiteral,
  reexpandAutomationInstance,
  replaceRecipeLiteral,
  type AutomationRecipe,
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

/** An instance whose code came out unchanged is counted nowhere: nothing was saved. */
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

const EDITED_BY_HAND_DETAIL =
  'the code was edited by hand, so the template no longer updates it; convert it to a free automation or create it again from the template'

/** True when the block's code is still exactly what the generator wrote. */
function isGeneratedCode(code: string, recipe: AutomationRecipe): boolean {
  const stamped = recipe.template?.codeHash
  return stamped !== undefined && instanceCodeHash(code) === stamped
}

/** The hand-edited block, flagged in its literal and otherwise byte for byte; null when already flagged. */
function flaggedAsEdited(code: string, recipe: AutomationRecipe): string | null {
  const link = recipe.template
  if (link === undefined) return null
  if (link.problems?.some((p) => p.code === 'edited-by-hand') === true) return null
  return replaceRecipeLiteral(code, {
    ...recipe,
    template: { ...link, problems: [{ code: 'edited-by-hand', detail: EDITED_BY_HAND_DETAIL }] },
  })
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
        if (!isGeneratedCode(block.code, recipe)) {
          const flaggedCode = flaggedAsEdited(block.code, recipe)
          if (flaggedCode === null) continue
          try {
            await deps.saveCode(block.id, flaggedCode)
          } catch (error: unknown) {
            failed += 1
            deps.logger.warn('automation template: a hand-edited instance could not be flagged', {
              meta: { templateId, blockId: block.id, error: errorText(error) },
            })
            continue
          }
          flagged += 1
          deps.logger.warn(
            'automation template: an instance was edited by hand, it is flagged and not regenerated',
            { meta: { templateId, blockId: block.id } },
          )
          continue
        }
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
        const code = generateAutomationBlock({ name: block.name, recipe: prepared.recipe })
        if (code === block.code) continue
        try {
          await deps.saveCode(block.id, code)
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
