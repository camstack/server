import { type CustomActionsSpec, customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/**
 * The forced delete of a storage location (D49). `deleteInstance` keeps the occupancy refusal;
 * this is the separate, explicit action for a location the check could not read (a removed disk,
 * another node, a remote provider). The caller states it after a second confirmation.
 */
export const forceDeleteLocationInput: z.ZodType<{ id: string }> = z.object({
  id: z.string().min(1),
})

export const storageOrchestratorActions: CustomActionsSpec = defineCustomActions({
  forceDeleteLocation: customAction(forceDeleteLocationInput, z.object({ ok: z.literal(true) }), {
    kind: 'mutation',
    auth: 'admin',
  }),
})
