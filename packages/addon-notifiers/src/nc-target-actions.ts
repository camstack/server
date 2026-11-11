/**
 * nc-target-actions — the one `notifiers` action the Notification Center viewer calls.
 *
 * A user's own targets are instances (D1013, epic #440): the viewer lists, creates, edits,
 * switches, tests and deletes them through `integration-instances` pinned to `notifiers`,
 * caller-scoped by `scopeInstancesToCaller`. What stays here is `nc.listTargetKinds`, the add
 * form's kind catalogue (form, byte budgets, icons): read-only, no row, and a viewer session may
 * not call `notification-output` itself.
 */

import {
  type CustomActionCaller,
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
    caller?: CustomActionCaller,
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
