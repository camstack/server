/**
 * Record kinds owned by core-blocks (phase 4).
 */
import {
  ActionStepSchema,
  ActionVariableSchema,
  AutomationStateDocSchema,
  defineRecordKinds,
  type DefinedRecordKind,
} from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

export const CORE_BLOCKS_COLLECTION = 'core_blocks'
export const CORE_BLOCK_SETTINGS_COLLECTION = 'core-blocks:settings'

export type CoreBlockRowBody = {
  readonly name: string
  readonly enabled: boolean
  readonly placement: string
  readonly updatedAt: number
  readonly block: Record<string, unknown>
}
const _coreBlockRowBody: z.ZodType<CoreBlockRowBody> = z.object({
  name: z.string(),
  enabled: z.boolean(),
  placement: z.string(),
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
  readonly createdAt: number
  readonly updatedAt: number
}
export const ActionRowBodySchema: z.ZodType<ActionRowBody> = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(ActionStepSchema).min(1).max(50),
  variables: z.array(ActionVariableSchema).max(20).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** The actions one camera links (D356: the operator picked them). Row id = the deviceId. */
export type ActionLinksRowBody = { readonly actionIds: string[] }
export const ActionLinksRowBodySchema: z.ZodType<ActionLinksRowBody> = z.object({
  actionIds: z.array(z.string().min(1)).max(100),
})

const _coreBlocksRecordKinds = defineRecordKinds({
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
  'action-links': {
    schema: ActionLinksRowBodySchema,
    class: 'config',
    writeTrigger: 'the operator picks the actions a camera links (setLinks)',
    device: 'required',
    at: 'none',
    deviceRemoval: 'delete',
    retention: { none: 'the row goes with its camera (device removal)' },
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
  readonly blocks: DefinedRecordKind<z.ZodType<CoreBlockRowBody>>
  readonly runs: DefinedRecordKind<z.ZodType<RunsRowBody>>
  readonly actions: DefinedRecordKind<z.ZodType<ActionRowBody>>
  readonly 'action-links': DefinedRecordKind<z.ZodType<ActionLinksRowBody>>
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
