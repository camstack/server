/**
 * Record kinds owned by integration-registry (phase 4).
 */
import { defineRecordKinds, type DefinedRecordKind } from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

export const INTEGRATIONS_LEGACY = 'integrations'
export const INTEGRATION_SETTINGS_LEGACY = 'integration_settings'

export type IntegrationBody = {
  readonly addonId: string
  readonly name: string
  readonly enabled: boolean
  readonly info: Record<string, unknown>
  readonly originStableId?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}
const _integrationBody: z.ZodType<IntegrationBody> = z.object({
  addonId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  info: z.record(z.string(), z.unknown()),
  originStableId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export const IntegrationBodySchema: z.ZodType<IntegrationBody> = _integrationBody

export type IntegrationSettingBody = {
  readonly integrationId: string
  readonly key: string
  readonly value: string
  readonly valueType: string
}
const _integrationSettingBody: z.ZodType<IntegrationSettingBody> = z.object({
  integrationId: z.string(),
  key: z.string(),
  value: z.string(),
  valueType: z.string(),
})
export const IntegrationSettingBodySchema: z.ZodType<IntegrationSettingBody> =
  _integrationSettingBody

const _integrationRegistryRecordKinds = defineRecordKinds({
  integrations: {
    schema: IntegrationBodySchema,
    class: 'config',
    writeTrigger: 'createIntegration / updateIntegration / deleteIntegration',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'addon_id', fields: ['addonId'] }],
    retention: { none: 'deleteIntegration only' },
  },
  'integration-settings': {
    schema: IntegrationSettingBodySchema,
    class: 'config',
    writeTrigger: 'setIntegrationSetting — one row per (integrationId, key)',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'integration_id', fields: ['integrationId'] }],
    retention: { none: 'cascade on deleteIntegration' },
  },
}) satisfies IsolatedRecordKinds

export type IntegrationRegistryRecordKindsMap = {
  readonly integrations: DefinedRecordKind<z.ZodType<IntegrationBody>>
  readonly 'integration-settings': DefinedRecordKind<z.ZodType<IntegrationSettingBody>>
}

export const integrationRegistryRecordKinds: IntegrationRegistryRecordKindsMap =
  _integrationRegistryRecordKinds

export const integrationsRecordKind: DefinedRecordKind<z.ZodType<IntegrationBody>> =
  _integrationRegistryRecordKinds.integrations

export const integrationSettingsRecordKind: DefinedRecordKind<z.ZodType<IntegrationSettingBody>> =
  _integrationRegistryRecordKinds['integration-settings']
