/**
 * HomeKit Export — customActions catalog. `regenerateBridge` is the instance form's
 * "Regenerate setup code" button (`addon-action-button`, `paramsStatic.instanceId`); admin only,
 * because it unpairs every controller of the bridge.
 */
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

export const exportHapActions = defineCustomActions({
  regenerateBridge: customAction(
    z.object({ instanceId: z.string().min(1) }),
    z.object({ regenerated: z.boolean() }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type ExportHapActions = typeof exportHapActions
