import { z } from 'zod'

/**
 * Which integration instance a settings form is for. An addon that serves several instances
 * (`instanceMode: multiple`) can show a different form per instance — an NVR integration
 * needs its connection, the default integration needs the addon's own sections.
 *
 * - `integrationId` is `null` in the create wizard: nothing exists yet, the operator is
 *   setting up a NEW instance.
 * - `mode` is the wizard mode of the integration type (`getAvailableTypes`).
 * - `candidateStableId` is the discovery candidate a wizard was seeded from, if any.
 */
export const IntegrationInstanceRefSchema = z.object({
  integrationId: z.string().nullable(),
  mode: z.enum(['standalone', 'account', 'broker']),
  candidateStableId: z.string().optional(),
})

export type IntegrationInstanceRef = z.infer<typeof IntegrationInstanceRefSchema>
