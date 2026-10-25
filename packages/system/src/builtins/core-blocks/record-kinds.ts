/**
 * Record kinds owned by core-blocks (phase 4).
 */
import { defineRecordKinds, type DefinedRecordKind } from '@camstack/types'
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
  readonly settings: DefinedRecordKind<z.ZodType<CoreBlockSettingsBody>>
}

export const coreBlocksRecordKinds: CoreBlocksRecordKindsMap = _coreBlocksRecordKinds

export const coreBlocksBlocksRecordKind: DefinedRecordKind<z.ZodType<CoreBlockRowBody>> =
  _coreBlocksRecordKinds.blocks

export const coreBlocksSettingsRecordKind: DefinedRecordKind<z.ZodType<CoreBlockSettingsBody>> =
  _coreBlocksRecordKinds.settings
