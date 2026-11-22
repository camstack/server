/**
 * Triggers of an actuator group: a source (what happens) and an instantaneous
 * action on the GROUP (on, off, switch, climate mode / target). Stored in the
 * group's helper spec with stable refs, never numeric ids; core-blocks compiles
 * them into the one automation block the group owns (`ownedBy`). The group
 * stays pure derivation: a trigger only ever commands the group device, and the
 * composer's fan-out does the rest. No timer lives here — a delayed off is an
 * automation.
 */
import { z } from 'zod'
import { DetectionSubjectSchema } from '../../automation/detection-subject.js'
import { DeviceFiredMatchSchema } from '../../automation/when.js'
import { EventVocabularyKindSchema } from '../../capabilities/event-vocabulary.js'
import { HvacModeSchema } from '../../capabilities/climate-control.cap.js'
import { EventCategory } from '../../enums/event-category.js'
import { type CompositionSourceRef, CompositionSourceRefSchema } from '../source-ref.js'

export const MAX_GROUP_TRIGGERS = 16
/** Also a valid event-leaf id, so a trigger id names its leaf in the generated block. */
export const GROUP_TRIGGER_ID_RE: RegExp = /^[a-z0-9][a-z0-9-]{0,39}$/

/** A button / event-emitter press. Every list is an OR, the lists together an AND. */
const FiredSourceSchema = z.object({
  kind: z.literal('fired'),
  device: CompositionSourceRefSchema,
  eventIds: z.array(z.string().min(1)).min(1).max(64).optional(),
  sourceIds: z.array(z.string().min(1)).min(1).max(64).optional(),
  kinds: z.array(EventVocabularyKindSchema).min(1).optional(),
  match: z.array(DeviceFiredMatchSchema).min(1).max(8).optional(),
})

/** An event of a category (doorbell, motion …), optionally from one device. */
const EventSourceSchema = z.object({
  kind: z.literal('event'),
  category: z.enum(EventCategory),
  device: CompositionSourceRefSchema.optional(),
})

/** A detection with subjects, optional zones and a minimum score. */
const DetectionSourceSchema = z.object({
  kind: z.literal('detection'),
  devices: z.array(CompositionSourceRefSchema).min(1).max(16),
  subjects: z.array(DetectionSubjectSchema).min(1),
  zones: z.array(z.string().min(1)).min(1).optional(),
  minScore: z.number().min(0).max(1).optional(),
})

/** A boolean field of another device becomes true / false (switch.on, contact.open …). */
const BecomesSourceSchema = z.object({
  kind: z.literal('becomes'),
  device: CompositionSourceRefSchema,
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
  becomes: z.boolean(),
})

export const GroupTriggerSourceSchema = z.discriminatedUnion('kind', [
  FiredSourceSchema,
  EventSourceSchema,
  DetectionSourceSchema,
  BecomesSourceSchema,
])
export type GroupTriggerSource = z.infer<typeof GroupTriggerSourceSchema>

/** What a trigger does to the GROUP. `switch` is the toggle computed on the group's aggregate, never per member. */
export const GroupTriggerActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('on') }),
  z.object({ kind: z.literal('off') }),
  z.object({ kind: z.literal('switch') }),
  z.object({
    kind: z.literal('climate'),
    mode: HvacModeSchema.optional(),
    target: z.number().optional(),
  }),
])
export type GroupTriggerAction = z.infer<typeof GroupTriggerActionSchema>

export const GroupTriggerSchema = z.object({
  id: z.string().regex(GROUP_TRIGGER_ID_RE),
  label: z.string().min(1).max(80).optional(),
  /** Only an explicit `false` disables. */
  enabled: z.boolean().optional(),
  source: GroupTriggerSourceSchema,
  action: GroupTriggerActionSchema,
})
export type GroupTrigger = z.infer<typeof GroupTriggerSchema>

/** A trigger list: bounded, ids unique, a climate action carries something to set. */
export const GroupTriggersSchema = z
  .array(GroupTriggerSchema)
  .max(MAX_GROUP_TRIGGERS)
  .superRefine((triggers, ctx) => {
    const seen = new Set<string>()
    triggers.forEach((trigger, index) => {
      if (seen.has(trigger.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `trigger id "${trigger.id}" is used twice`,
          path: [index, 'id'],
        })
      }
      seen.add(trigger.id)
      const action = trigger.action
      if (action.kind === 'climate' && action.mode === undefined && action.target === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'a climate trigger sets the mode, the target, or both',
          path: [index, 'action'],
        })
      }
    })
  })

export function triggerEnabled(trigger: GroupTrigger): boolean {
  return trigger.enabled !== false
}

/** Every device a trigger listens to (an event with no device listens to none). */
export function triggerSourceRefs(trigger: GroupTrigger): readonly CompositionSourceRef[] {
  const source = trigger.source
  switch (source.kind) {
    case 'fired':
    case 'becomes':
      return [source.device]
    case 'event':
      return source.device === undefined ? [] : [source.device]
    case 'detection':
      return source.devices
  }
}
