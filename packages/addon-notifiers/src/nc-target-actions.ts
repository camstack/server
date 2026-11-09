/**
 * nc-target-actions — the one `notifiers` action the Notification Center viewer still rides.
 *
 * A user's own targets are instances (D1013, epic #440): the viewer lists, creates, edits,
 * switches, tests and deletes them through `integration-instances` pinned to `notifiers`, and the
 * provider keeps every call to the caller's own rows (`scopeInstancesToCaller`). What stays here
 * is the kind catalogue the add form is drawn from: it is read-only, carries no row, and a
 * viewer session may not call `notification-output` directly.
 */

import {
  customAction,
  defineCustomActions,
  type INotificationOutputProvider,
  TargetKindSchema,
} from '@camstack/types'
import { z } from 'zod'

export const ncTargetActions = defineCustomActions({
  'nc.listTargetKinds': customAction(z.object({}), z.object({ kinds: z.array(TargetKindSchema) })),
})

export type NcTargetActions = typeof ncTargetActions

/** The typed handler map, shaped exactly like `AddonInitResult.actionHandlers`. */
export type NcTargetActionHandlers = {
  readonly [K in keyof NcTargetActions & string]: (
    input: z.infer<NcTargetActions[K]['input']>,
  ) => Promise<z.infer<NcTargetActions[K]['output']>>
}

export interface NcTargetActionDeps {
  readonly provider: Pick<INotificationOutputProvider, 'listTargetKinds'>
}

export function makeNcTargetHandlers(deps: NcTargetActionDeps): NcTargetActionHandlers {
  return {
    'nc.listTargetKinds': async () => ({ kinds: await deps.provider.listTargetKinds({}) }),
  }
}
