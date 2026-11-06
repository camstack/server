/**
 * Record kinds owned by integration-registry (phase 4).
 *
 * An integration's configuration is the addon's own instance record. This owner
 * keeps only the registry row (id, addon, name, enabled, info).
 */
import { defineRecordKinds, type DefinedRecordKind } from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

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
}) satisfies IsolatedRecordKinds

export type IntegrationRegistryRecordKindsMap = {
  readonly integrations: DefinedRecordKind<z.ZodType<IntegrationBody>>
}

export const integrationRegistryRecordKinds: IntegrationRegistryRecordKindsMap =
  _integrationRegistryRecordKinds

export const integrationsRecordKind: DefinedRecordKind<z.ZodType<IntegrationBody>> =
  _integrationRegistryRecordKinds.integrations
