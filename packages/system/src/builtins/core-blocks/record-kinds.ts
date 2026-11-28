/**
 * Record kinds owned by core-blocks (phase 4).
 */
import {
  ActionMinDelaySecSchema,
  ActionStepSchema,
  ActionVariableSchema,
  TagIdsFieldSchema,
  TagsFieldSchema,
  TagBodySchema,
  type TagBody,
  TagStyleSchema,
  type TagStyle,
  type DaylightSettings,
  DaylightSettingsSchema,
  type Scheduler,
  SchedulerSchema,
  AutomationStateDocSchema,
  TemplateKindSchema,
  defineRecordKinds,
  type DefinedRecordKind,
} from '@dominevo/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

export const CORE_BLOCKS_COLLECTION = 'core_blocks'
export const CORE_BLOCK_SETTINGS_COLLECTION = 'core-blocks:settings'

export type CoreBlockRowBody = {
  readonly name: string
  readonly enabled: boolean
  readonly updatedAt: number
  readonly block: Record<string, unknown>
}
const _coreBlockRowBody: z.ZodType<CoreBlockRowBody> = z.object({
  name: z.string(),
  enabled: z.boolean(),
  updatedAt: z.number(),
  block: z.record(z.string(), z.unknown()),
})
export const CoreBlockRowBodySchema: z.ZodType<CoreBlockRowBody> = _coreBlockRowBody

export type CoreBlockSettingsBody = {
  readonly values: Record<string, unknown>
}
const _coreBlockSettingsBody: z.ZodType<CoreBlockSettingsBody> = z.object({
  values: z.record(z.string(), z.unknown()),
})
export const CoreBlockSettingsBodySchema: z.ZodType<CoreBlockSettingsBody> = _coreBlockSettingsBody

/**
 * One owner's run ledger row: the cooldown stamp and the trace ring
 * (`AutomationStateDoc`), plus the last failure and when it was written. The
 * row id is the owner: `automation:<blockId>` or `action:<actionId>`.
 */
export type RunsRowBody = {
  readonly version: 1
  readonly lastRunStartedAt: number | null
  readonly traces: z.infer<typeof AutomationStateDocSchema>['traces']
  readonly lastError: string | null
  readonly updatedAt: number
  /** The devices an automation turned on and owes an off ("on for a time"). */
  readonly onForHolds?: z.infer<typeof AutomationStateDocSchema>['onForHolds']
}
export const RunsRowBodySchema: z.ZodType<RunsRowBody> = AutomationStateDocSchema.extend({
  lastError: z.string().nullable(),
  updatedAt: z.number(),
})

/** An internal action: the operator's steps and variables. The row id is the bare uuid. */
export type ActionRowBody = {
  readonly name: string
  readonly steps: z.infer<typeof ActionStepSchema>[]
  readonly variables?: z.infer<typeof ActionVariableSchema>[]
  readonly minDelaySec?: number
  readonly tags?: string[]
  readonly tagIds?: string[]
  readonly createdAt: number
  readonly updatedAt: number
}
export const ActionRowBodySchema: z.ZodType<ActionRowBody> = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(ActionStepSchema).min(1).max(50),
  variables: z.array(ActionVariableSchema).max(20).optional(),
  minDelaySec: ActionMinDelaySecSchema.optional(),
  tags: TagsFieldSchema.optional(),
  tagIds: TagIdsFieldSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** A scheduler (D983): the operator's timeline. The row id is the bare uuid. */
export type SchedulerRowBody = Omit<Scheduler, 'id'>
export const SchedulerRowBodySchema: z.ZodType<SchedulerRowBody> = SchedulerSchema.omit({
  id: true,
})

/**
 * How far the engine has processed a scheduler's points. Read at start to tell
 * a missed edge from one already run; reset to "now" when the operator edits
 * the scheduler (an edit never replays the past). Row id = the scheduler id.
 */
export type SchedulerStateRowBody = { readonly processedUntil: number }
export const SchedulerStateRowBodySchema: z.ZodType<SchedulerStateRowBody> = z.object({
  processedUntil: z.number(),
})

/** The daylight phase source (planning#736): ONE row, the cluster-wide setting. Row id = `settings`. */
export type DaylightSettingsRowBody = DaylightSettings
export const DaylightSettingsRowBodySchema: z.ZodType<DaylightSettingsRowBody> =
  DaylightSettingsSchema

/** The actions one camera links (D356: the operator picked them). Row id = the deviceId. */
export type ActionLinksRowBody = { readonly actionIds: string[]; readonly updatedAt?: number }
export const ActionLinksRowBodySchema: z.ZodType<ActionLinksRowBody> = z.object({
  actionIds: z.array(z.string().min(1)).max(100),
  /** The stamp a save must carry (D1098); a row written before it has none, which reads as 0. */
  updatedAt: z.number().optional(),
})

/** A template (D963): the kind names the payload schema, the store never reads the payload. */
export type TemplateRowBody = {
  readonly kind: z.infer<typeof TemplateKindSchema>
  readonly name: string
  readonly payload: unknown
  readonly tags?: string[]
  readonly tagIds?: string[]
  readonly createdAt: number
  readonly updatedAt: number
}
export const TemplateRowBodySchema: z.ZodType<TemplateRowBody> = z.object({
  kind: TemplateKindSchema,
  name: z.string().min(1).max(120),
  payload: z.unknown(),
  tags: TagsFieldSchema.optional(),
  tagIds: TagIdsFieldSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/**
 * The style of one tag (D1054): colour token and icon. The row id is the tag's
 * comparison key (`tagKey`: trimmed, lower-cased); `name` keeps the spelling the
 * operator chose. A tag lives on the record it labels — only the style is stored here.
 */
export type TagStyleRowBody = TagStyle
export const TagStyleRowBodySchema: z.ZodType<TagStyleRowBody> = TagStyleSchema

/**
 * A tag (D1089): a record with an opaque id, carrying its name, colour, icon and
 * description. Every owner references the id, so a rename is ONE write here.
 */
export type TagRowBody = TagBody
export const TagRowBodySchema: z.ZodType<TagRowBody> = TagBodySchema

/**
 * A pending timed run (D993): the device is on and the hub owes it an off at
 * `activeUntil`. One row per device, written BEFORE the device is switched on,
 * so a crash can only ever cost a harmless extra off at boot. Row id = the
 * deviceId.
 */
export type TimedRunRowBody = {
  readonly activeUntil: number
  readonly requestedBy: string | null
  readonly requestedAt: number
  readonly actuator: 'switch' | 'pet-fountain'
}
export const TimedRunRowBodySchema: z.ZodType<TimedRunRowBody> = z.object({
  activeUntil: z.number(),
  requestedBy: z.string().nullable(),
  requestedAt: z.number(),
  actuator: z.enum(['switch', 'pet-fountain']),
})

/**
 * Which composition block owns a composed device. Row id = the deviceId; the
 * device-removal hook resolves the owner of a tombstone from it, because the
 * tombstone carries no stableId and the device is gone from the registry (#706).
 */
export type ComposedDeviceRowBody = { readonly blockId: string }
export const ComposedDeviceRowBodySchema: z.ZodType<ComposedDeviceRowBody> = z.object({
  blockId: z.string(),
})

const _coreBlocksRecordKinds = defineRecordKinds({
  'composed-devices': {
    schema: ComposedDeviceRowBodySchema,
    class: 'config',
    writeTrigger:
      'a read of the composer devices saw a composed device (boot, device registered); the removal hook deletes it with the device',
    device: 'none',
    at: 'none',
    retention: {
      none: 'the device-removal hook deletes the row once the composition is retired',
    },
  },
  'timed-runs': {
    schema: TimedRunRowBodySchema,
    class: 'config',
    writeTrigger:
      'timed-run.runFor arms a deadline; cancel, a manual off or the deadline removes it',
    device: 'required',
    at: 'none',
    deviceRemoval: 'delete',
    retention: {
      none: 'the row goes with its deadline, a manual off, or its device (device removal)',
    },
  },
  blocks: {
    schema: CoreBlockRowBodySchema,
    class: 'config',
    writeTrigger: 'create / update / setStatus after compile',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'enabled', fields: ['enabled'] }],
    retention: { none: 'operator delete only' },
    maxDataBytes: 256 * 1024,
  },
  runs: {
    schema: RunsRowBodySchema,
    class: 'config',
    writeTrigger:
      'an automation block or an Action run reports a run (or a coalesced skip); the cooldown stamp moves when actions start',
    device: 'none',
    at: 'none',
    retention: {
      none: 'the row goes with its block or action; a start-up sweep removes orphans',
    },
    maxDataBytes: 1024 * 1024,
  },
  actions: {
    schema: ActionRowBodySchema,
    class: 'config',
    writeTrigger: 'create / update / delete of an internal action by the operator',
    device: 'none',
    at: 'none',
    retention: { none: 'operator delete only' },
    maxDataBytes: 256 * 1024,
  },
  schedulers: {
    schema: SchedulerRowBodySchema,
    class: 'config',
    writeTrigger: 'create / update / delete / setEnabled of a scheduler by the operator',
    device: 'none',
    at: 'none',
    retention: { none: 'operator delete only' },
    maxDataBytes: 256 * 1024,
  },
  'scheduler-state': {
    schema: SchedulerStateRowBodySchema,
    class: 'config',
    writeTrigger: 'the engine processed a scheduler point; the operator edited the scheduler',
    device: 'none',
    at: 'none',
    retention: { none: 'the row goes with its scheduler' },
  },
  'daylight-settings': {
    schema: DaylightSettingsRowBodySchema,
    class: 'config',
    writeTrigger: 'the operator sets the day/night source (daylight-phase.setSettings)',
    device: 'none',
    at: 'none',
    retention: { none: 'one row, replaced by the operator; absent means the sun' },
  },
  'action-links': {
    schema: ActionLinksRowBodySchema,
    class: 'config',
    writeTrigger: 'the operator picks the actions a camera links (setLinks)',
    device: 'required',
    at: 'none',
    deviceRemoval: 'delete',
    retention: { none: 'the row goes with its camera (device removal)' },
  },
  templates: {
    schema: TemplateRowBodySchema,
    class: 'config',
    writeTrigger: 'create / update / delete of a template by the operator',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'kind', fields: ['kind'] }],
    retention: {
      none: 'operator delete only; a template a device still uses is refused',
    },
    maxDataBytes: 256 * 1024,
  },
  tags: {
    schema: TagRowBodySchema,
    class: 'config',
    writeTrigger: 'ensureTag / updateTag / deleteTag, and the tags-as-records migration (D1089)',
    device: 'none',
    at: 'none',
    retention: { none: 'operator action only: deleting the tag' },
  },
  'tag-styles': {
    schema: TagStyleRowBodySchema,
    class: 'config',
    writeTrigger: 'legacy only — the tags-as-records migration reads then deletes rows (D1089)',
    device: 'none',
    at: 'none',
    retention: { none: 'rows deleted by the tags-as-records migration' },
  },
  settings: {
    schema: CoreBlockSettingsBodySchema,
    class: 'config',
    writeTrigger: 'legacy only — migrateRawSecrets reads then deletes rows (D880)',
    device: 'none',
    at: 'none',
    retention: { none: 'rows deleted by migrateRawSecrets' },
  },
}) satisfies IsolatedRecordKinds

export type CoreBlocksRecordKindsMap = {
  readonly 'composed-devices': DefinedRecordKind<z.ZodType<ComposedDeviceRowBody>>
  readonly 'timed-runs': DefinedRecordKind<z.ZodType<TimedRunRowBody>>
  readonly blocks: DefinedRecordKind<z.ZodType<CoreBlockRowBody>>
  readonly runs: DefinedRecordKind<z.ZodType<RunsRowBody>>
  readonly actions: DefinedRecordKind<z.ZodType<ActionRowBody>>
  readonly schedulers: DefinedRecordKind<z.ZodType<SchedulerRowBody>>
  readonly 'scheduler-state': DefinedRecordKind<z.ZodType<SchedulerStateRowBody>>
  readonly 'daylight-settings': DefinedRecordKind<z.ZodType<DaylightSettingsRowBody>>
  readonly 'action-links': DefinedRecordKind<z.ZodType<ActionLinksRowBody>>
  readonly templates: DefinedRecordKind<z.ZodType<TemplateRowBody>>
  readonly tags: DefinedRecordKind<z.ZodType<TagRowBody>>
  readonly 'tag-styles': DefinedRecordKind<z.ZodType<TagStyleRowBody>>
  readonly settings: DefinedRecordKind<z.ZodType<CoreBlockSettingsBody>>
}

export const coreBlocksRecordKinds: CoreBlocksRecordKindsMap = _coreBlocksRecordKinds

export const coreBlocksBlocksRecordKind: DefinedRecordKind<z.ZodType<CoreBlockRowBody>> =
  _coreBlocksRecordKinds.blocks

export const coreBlocksSettingsRecordKind: DefinedRecordKind<z.ZodType<CoreBlockSettingsBody>> =
  _coreBlocksRecordKinds.settings

export const coreBlocksRunsRecordKind: DefinedRecordKind<z.ZodType<RunsRowBody>> =
  _coreBlocksRecordKinds.runs

export const coreBlocksActionsRecordKind: DefinedRecordKind<z.ZodType<ActionRowBody>> =
  _coreBlocksRecordKinds.actions

export const coreBlocksActionLinksRecordKind: DefinedRecordKind<z.ZodType<ActionLinksRowBody>> =
  _coreBlocksRecordKinds['action-links']

export const coreBlocksTimedRunsRecordKind: DefinedRecordKind<z.ZodType<TimedRunRowBody>> =
  _coreBlocksRecordKinds['timed-runs']
