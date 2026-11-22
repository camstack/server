/**
 * The typed parameters of the `builtin:linked-trigger` automation template
 * (D1086): "this device is commanded when that device fires an event". An
 * instance is an ordinary automation made from the template, so the engine's
 * traces and run modes apply; the template only fixes the shape. The operator
 * reads and writes it from the COMMANDED device's Customize tab.
 *
 * Sources are events only: a device that fired (`device-fired`, optionally one
 * part, event, shared kind and payload predicates) or a device event of a
 * category. The action is a plain on, off or toggle of one capability of the
 * target. A linked trigger commands the target; it never claims the target's
 * state (that belongs to the target's own provider, D663).
 */
import { z } from 'zod'
import { EventVocabularyKindSchema } from '../capabilities/event-vocabulary.js'
import { DeviceFiredMatchSchema } from '../automation/when.js'
import type { TemplateInputValues } from '../automation/template-link.js'

export const LINKED_TRIGGER_TEMPLATE_ID = 'builtin:linked-trigger'
/** The input key whose value is the commanded device: the read keys on it. */
export const LINKED_TRIGGER_TARGET_INPUT = 'target'
export const LINKED_TRIGGER_SOURCES_MAX = 10

const deviceId = z.number().int().nonnegative()

/** A device of the `event-emitter` capability reported an event (a button press). */
export const LinkedTriggerFiredSourceSchema = z.object({
  kind: z.literal('device-fired'),
  deviceId,
  /** Parts of the device (a button's channel); absent matches any. */
  sourceIds: z.array(z.string().min(1)).min(1).max(64).optional(),
  /** The device's own event tokens (`PRESS_SHORT`); absent matches any. */
  eventIds: z.array(z.string().min(1)).min(1).max(64).optional(),
  kinds: z.array(EventVocabularyKindSchema).min(1).optional(),
  /** Payload predicates: each value at `path` of the fire's data equals `equals`. */
  match: z.array(DeviceFiredMatchSchema).min(1).max(8).optional(),
})

/** A device event of a category (an `EventCategory` value). */
export const LinkedTriggerEventSourceSchema = z.object({
  kind: z.literal('device-event'),
  deviceId,
  category: z.string().min(1),
})

export const LinkedTriggerSourceSchema = z.discriminatedUnion('kind', [
  LinkedTriggerFiredSourceSchema,
  LinkedTriggerEventSourceSchema,
])
export type LinkedTriggerSource = z.infer<typeof LinkedTriggerSourceSchema>

export const LINKED_TRIGGER_ACTIONS = ['on', 'off', 'toggle'] as const
export const LinkedTriggerActionSchema = z.enum(LINKED_TRIGGER_ACTIONS)
export type LinkedTriggerAction = z.infer<typeof LinkedTriggerActionSchema>

export const LinkedTriggerParamsSchema = z.object({
  targetDeviceId: deviceId,
  action: LinkedTriggerActionSchema,
  /** The capability the action is sent to (`switch.on`); a vocabulary action must exist for it. */
  capability: z.string().min(1).default('switch'),
  sources: z.array(LinkedTriggerSourceSchema).min(1).max(LINKED_TRIGGER_SOURCES_MAX),
})
export type LinkedTriggerParams = z.input<typeof LinkedTriggerParamsSchema>

/** The template input values for the parameters; the template judges them again. */
export function linkedTriggerValues(params: LinkedTriggerParams): TemplateInputValues {
  const parsed = LinkedTriggerParamsSchema.parse(params)
  return {
    [LINKED_TRIGGER_TARGET_INPUT]: parsed.targetDeviceId,
    action: { actionId: `${parsed.capability}.${parsed.action}` },
    when: parsed.sources.map((source) => ({ ...source })),
  }
}

const ActionValueSchema = z.object({ actionId: z.string().min(1) })

/**
 * The parameters stored values describe, or null when they are not a linked
 * trigger this release can read (an unknown action, a source kind it does not
 * know). The Customize tab shows such an instance as unreadable; it never
 * rewrites what it could not read.
 */
export function linkedTriggerParamsOf(
  values: TemplateInputValues,
): z.output<typeof LinkedTriggerParamsSchema> | null {
  const action = ActionValueSchema.safeParse(values['action'])
  if (!action.success) return null
  const dot = action.data.actionId.lastIndexOf('.')
  if (dot <= 0) return null
  const parsed = LinkedTriggerParamsSchema.safeParse({
    targetDeviceId: values[LINKED_TRIGGER_TARGET_INPUT],
    capability: action.data.actionId.slice(0, dot),
    action: action.data.actionId.slice(dot + 1),
    sources: values['when'],
  })
  return parsed.success ? parsed.data : null
}
