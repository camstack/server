/**
 * The typed parameters of the `builtin:linked-trigger` automation template
 * (D1086): "this device is commanded when that device fires an event". An
 * instance is an ordinary automation made from the template, so the engine's
 * traces and run modes apply; the template only fixes the shape. The operator
 * reads and writes it from the COMMANDED device's Customize tab.
 *
 * A source is something that HAPPENS: a device that fired (`device-fired`,
 * optionally one part, event, shared kind and payload predicates), a device
 * event of a category, a device field taking a value (`device-becomes`: motion
 * detected), or a camera detecting a class (`detection`). The action is a plain
 * on, off or toggle of one capability of the target. "On" may be held for a
 * time (`onForSeconds`): the engine turns the target on only if it is off and
 * off again when the time is up, each new event restarting the time
 * (`automation/on-for.ts`). An optional time window limits when it runs. A
 * linked trigger commands the target; it never claims the target's state (that
 * belongs to the target's own provider, D663).
 */
import { z } from 'zod'
import { EventVocabularyKindSchema } from '../capabilities/event-vocabulary.js'
import { DetectionSubjectSchema } from '../automation/detection-subject.js'
import { ON_FOR_MAX_SECONDS, onForActionOf } from '../automation/on-for.js'
import {
  TemplateDeviceStateValueSchema,
  TemplateTimeWindowValueSchema,
  type TemplateInputValues,
} from '../automation/template-link.js'
import { DeviceFiredMatchSchema } from '../automation/when.js'

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

/** A field of a device takes a value (a motion sensor's `detected` becomes true). */
export const LinkedTriggerBecomesSourceSchema = z.object({
  kind: z.literal('device-becomes'),
  deviceId,
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
  becomes: z.union([z.string(), z.number(), z.boolean()]),
})

/** A camera detects one of the listed classes. */
export const LinkedTriggerDetectionSourceSchema = z.object({
  kind: z.literal('detection'),
  deviceIds: z.array(deviceId).min(1),
  subjects: z.array(DetectionSubjectSchema).min(1),
})

export const LinkedTriggerSourceSchema = z.discriminatedUnion('kind', [
  LinkedTriggerFiredSourceSchema,
  LinkedTriggerEventSourceSchema,
  LinkedTriggerBecomesSourceSchema,
  LinkedTriggerDetectionSourceSchema,
])
export type LinkedTriggerSource = z.infer<typeof LinkedTriggerSourceSchema>

export const LINKED_TRIGGER_ACTIONS = ['on', 'off', 'toggle'] as const
export const LinkedTriggerActionSchema = z.enum(LINKED_TRIGGER_ACTIONS)
export type LinkedTriggerAction = z.infer<typeof LinkedTriggerActionSchema>

/** The template input keys of the optional duration and time window. */
export const LINKED_TRIGGER_ON_FOR_INPUT = 'onFor'
export const LINKED_TRIGGER_WINDOW_INPUT = 'active'
/** The optional limit on the state of a device (a derived "is night"). */
export const LINKED_TRIGGER_STATE_INPUT = 'activeWhen'

export const LinkedTriggerParamsSchema = z
  .object({
    targetDeviceId: deviceId,
    action: LinkedTriggerActionSchema,
    /** The capability the action is sent to (`switch.on`); a vocabulary action must exist for it. */
    capability: z.string().min(1).default('switch'),
    /** With `on`: on only if it is off, and off again after this long. */
    onForSeconds: z.number().int().min(1).max(ON_FOR_MAX_SECONDS).optional(),
    /** Only inside this time of day and these days. */
    activeWindow: TemplateTimeWindowValueSchema.optional(),
    /** Only while this device field holds this value (a derived "is night" reads on). */
    activeWhen: TemplateDeviceStateValueSchema.optional(),
    sources: z.array(LinkedTriggerSourceSchema).min(1).max(LINKED_TRIGGER_SOURCES_MAX),
  })
  .superRefine((params, ctx) => {
    if (params.onForSeconds === undefined) return
    if (onForActionOf(`${params.capability}.${params.action}`) === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'only "on" can be held for a time',
        path: ['onForSeconds'],
      })
    }
  })
export type LinkedTriggerParams = z.input<typeof LinkedTriggerParamsSchema>

/** The template input values for the parameters; the template judges them again. */
export function linkedTriggerValues(params: LinkedTriggerParams): TemplateInputValues {
  const parsed = LinkedTriggerParamsSchema.parse(params)
  return {
    [LINKED_TRIGGER_TARGET_INPUT]: parsed.targetDeviceId,
    action: { actionId: `${parsed.capability}.${parsed.action}` },
    when: parsed.sources.map((source) => ({ ...source })),
    ...(parsed.onForSeconds === undefined
      ? {}
      : { [LINKED_TRIGGER_ON_FOR_INPUT]: parsed.onForSeconds }),
    ...(parsed.activeWindow === undefined
      ? {}
      : { [LINKED_TRIGGER_WINDOW_INPUT]: parsed.activeWindow }),
    ...(parsed.activeWhen === undefined ? {} : { [LINKED_TRIGGER_STATE_INPUT]: parsed.activeWhen }),
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
    ...(values[LINKED_TRIGGER_ON_FOR_INPUT] === undefined
      ? {}
      : { onForSeconds: values[LINKED_TRIGGER_ON_FOR_INPUT] }),
    ...(values[LINKED_TRIGGER_WINDOW_INPUT] === undefined
      ? {}
      : { activeWindow: values[LINKED_TRIGGER_WINDOW_INPUT] }),
    ...(values[LINKED_TRIGGER_STATE_INPUT] === undefined
      ? {}
      : { activeWhen: values[LINKED_TRIGGER_STATE_INPUT] }),
  })
  return parsed.success ? parsed.data : null
}
