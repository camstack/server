/**
 * The link an automation made FROM a template carries (#527): which template,
 * the values the operator filled in, and — when the template has since changed
 * so that those values no longer fit — the problems that say why.
 *
 * It lives inside the recipe (`AutomationRecipe.template`), so the one row in
 * `core_blocks` stays the one artefact: there is no second store of instances
 * to drift from the blocks, and deleting the automation deletes the link.
 * "Convert to a free automation" is dropping this field.
 *
 * This file depends on nothing in `recipe.ts`, so the recipe can embed it and
 * the template engine (`template/automation-template.ts`) can import both.
 */
import { z } from 'zod'
import { EventVocabularyKindSchema } from '../capabilities/event-vocabulary.js'

/** An `event` input's value: the same three narrowing lists a `device-fired` row takes. */
export const TemplateEventValueSchema = z
  .object({
    eventIds: z.array(z.string().min(1)).min(1).max(64).optional(),
    sourceIds: z.array(z.string().min(1)).min(1).max(64).optional(),
    kinds: z.array(EventVocabularyKindSchema).min(1).optional(),
  })
  .refine(
    (value) =>
      value.eventIds !== undefined || value.sourceIds !== undefined || value.kinds !== undefined,
    { message: 'an event names at least one event, part or kind' },
  )
export type TemplateEventValue = z.infer<typeof TemplateEventValueSchema>

/** An `action` input's value: a vocabulary action and its open args. */
export const TemplateActionValueSchema = z.object({
  actionId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
})
export type TemplateActionValue = z.infer<typeof TemplateActionValueSchema>

/** The value of one non-group input. Which member is right is the input kind's to judge. */
export const TemplateScalarValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.number().int().nonnegative()),
  TemplateEventValueSchema,
  TemplateActionValueSchema,
])
export type TemplateScalarValue = z.infer<typeof TemplateScalarValueSchema>

/** One row of a repeatable group: row-input key → value. */
export const TemplateGroupRowSchema = z.record(z.string(), TemplateScalarValueSchema)
export type TemplateGroupRow = z.infer<typeof TemplateGroupRowSchema>

export const TemplateInputValueSchema = z.union([
  TemplateScalarValueSchema,
  z.array(TemplateGroupRowSchema),
])
export type TemplateInputValue = z.infer<typeof TemplateInputValueSchema>

/** Input key → value. */
export const TemplateInputValuesSchema = z.record(z.string(), TemplateInputValueSchema)
export type TemplateInputValues = z.infer<typeof TemplateInputValuesSchema>

export const TEMPLATE_INSTANCE_PROBLEM_CODES = [
  /** A required input has no value. */
  'missing-input',
  /** A value the input's kind or bounds refuse. */
  'invalid-input',
  /** The expansion is not a valid automation. */
  'invalid-recipe',
  /** The template the instance points at is gone. */
  'missing-template',
  /** The code was changed outside the generator: it is no longer re-expanded. */
  'edited-by-hand',
] as const
export const TemplateInstanceProblemSchema = z.object({
  code: z.enum(TEMPLATE_INSTANCE_PROBLEM_CODES),
  /** Dotted input address (`buttons.2.targets`); absent for a whole-recipe problem. */
  input: z.string().optional(),
  detail: z.string(),
})
export type TemplateInstanceProblem = z.infer<typeof TemplateInstanceProblemSchema>

export const AutomationTemplateLinkSchema = z.object({
  templateId: z.string().min(1),
  values: TemplateInputValuesSchema,
  /**
   * Fingerprint of the generated code with this literal blanked
   * (`instanceCodeHash`), stamped by `generateAutomationBlock`. Code that no
   * longer matches it was edited by hand, and is never regenerated over.
   */
  codeHash: z.string().optional(),
  /**
   * Present when the last re-expansion refused these values. The automation
   * keeps running the body of its last good expansion; nothing is dropped.
   */
  problems: z.array(TemplateInstanceProblemSchema).min(1).optional(),
})
export type AutomationTemplateLink = z.infer<typeof AutomationTemplateLinkSchema>
