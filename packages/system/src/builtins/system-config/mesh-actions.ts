/**
 * System → Cluster — agent-ui unlock tickets (D821).
 */
import { z } from 'zod'
import { customAction, defineCustomActions, type CustomActionsSpec } from '@camstack/types'

const mintAgentUiUnlockInputSchema: z.ZodTypeAny = z.object({
  nodeId: z.string().min(1),
  /**
   * Preferred agent dashboard base (`http://host:4444`). When set, the
   * answer includes `dashboardUrl` with `?ticket=` already attached.
   */
  dashboardBaseUrl: z.string().url().optional(),
})

const mintAgentUiUnlockOutputSchema: z.ZodTypeAny = z.object({
  ticket: z.string().min(1),
  exp: z.number().int(),
  nodeId: z.string().min(1),
  dashboardUrl: z.string().url().optional(),
})

export const systemConfigMeshActions: CustomActionsSpec = defineCustomActions({
  /** Hub admin → short-lived ticket the agent redeems for a tab session (D821). */
  mintAgentUiUnlockTicket: customAction(
    mintAgentUiUnlockInputSchema,
    mintAgentUiUnlockOutputSchema,
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type SystemConfigMeshActions = typeof systemConfigMeshActions
