/**
 * nc-target-actions — the `notifiers` actions the SHIPPED Notification Center viewer calls.
 *
 * A user's own targets are instances (D1013, epic #440): the one door is `integration-instances`
 * pinned to `notifiers`, caller-scoped by `scopeInstancesToCaller`. The viewer release in the
 * field still calls the `nc.*MyTarget*` names below, so they stay as THIN DELEGATES onto that
 * door: same input and output shapes the viewer reads, no second store, and the ownership rule
 * is the door's (the row's `ownerUserId`).
 *
 * REMOVE the five `nc.*MyTarget*` actions once a viewer release talks to the door
 * (`integrationInstances` with `addonId: 'notifiers'`); `nc.listTargetKinds` (the add form's kind
 * catalogue, read-only, no row) is the only one that stays.
 *
 * FAIL-CLOSED: an absent forwarded caller is rejected before anything is read, never treated as
 * admin. A target the caller does not own (a global one, another user's) is refused for an admin
 * as well: the viewer manages its own targets only, the admin page manages the rest.
 */

import {
  type CustomActionCaller,
  customAction,
  defineCustomActions,
  forbiddenError,
  type IIntegrationInstancesProvider,
  type IntegrationInstance,
  type INotificationOutputProvider,
  TARGET_OWNER_KEY,
  type Target,
  TargetKindSchema,
  TargetSchema,
} from '@camstack/types'
import { z } from 'zod'

export const ncTargetActions = defineCustomActions({
  'nc.listMyTargets': customAction(z.object({}), z.object({ targets: z.array(TargetSchema) }), {
    caller: 'required',
  }),
  'nc.listTargetKinds': customAction(z.object({}), z.object({ kinds: z.array(TargetKindSchema) })),
  'nc.upsertMyTarget': customAction(
    z.object({ target: TargetSchema }),
    z.object({ target: TargetSchema }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.deleteMyTarget': customAction(
    z.object({ targetId: z.string() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.setMyTargetEnabled': customAction(
    z.object({ targetId: z.string(), enabled: z.boolean() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.testMyTarget': customAction(
    z.object({ targetId: z.string() }),
    z.object({ success: z.boolean(), error: z.string().optional() }),
    { kind: 'mutation', caller: 'required' },
  ),
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
  /** The caller-scoped `integration-instances` provider of this addon: the one store. */
  readonly instances: IIntegrationInstancesProvider
  readonly addonId?: string
}

function requireCaller(caller: CustomActionCaller | undefined): CustomActionCaller {
  if (!caller || typeof caller.userId !== 'string' || caller.userId.length === 0) {
    throw forbiddenError('authenticated caller required')
  }
  return caller
}

export function makeNcTargetHandlers(deps: NcTargetActionDeps): NcTargetActionHandlers {
  const addonId = deps.addonId ?? 'notifiers'
  const owns = (instance: IntegrationInstance | null, userId: string): instance is IntegrationInstance =>
    instance !== null && instance.formValues[TARGET_OWNER_KEY] === userId
  const asTarget = (instance: IntegrationInstance): Target => ({
    id: instance.id,
    name: instance.name,
    kind: instance.kind,
    addonId,
    enabled: instance.enabled !== false,
    config: { ...instance.formValues },
  })
  /** The caller's own stored target; anything else (global, foreign, absent) is refused. */
  const requireOwn = async (id: string, caller: CustomActionCaller): Promise<void> => {
    if (!owns(await deps.instances.getInstance({ id, caller }), caller.userId)) {
      throw forbiddenError(`target not owned: ${id}`)
    }
  }

  return {
    'nc.listMyTargets': async (_input, caller) => {
      const c = requireCaller(caller)
      const rows = await deps.instances.listInstances({ mine: true, caller: c })
      return { targets: rows.filter((row) => owns(row, c.userId)).map(asTarget) }
    },

    'nc.listTargetKinds': async () => ({ kinds: await deps.provider.listTargetKinds({}) }),

    'nc.upsertMyTarget': async (input, caller) => {
      const c = requireCaller(caller)
      const { target } = input
      // The owner is the caller's, whatever the client sent.
      const values = { ...target.config, [TARGET_OWNER_KEY]: c.userId }
      const existing =
        target.id.length > 0 ? await deps.instances.getInstance({ id: target.id, caller: c }) : null
      // An edit only of an own row; a foreign or empty id mints a fresh one.
      let id: string
      if (owns(existing, c.userId)) {
        id = existing.id
        await deps.instances.updateInstance({ id, name: target.name, values, caller: c })
      } else {
        id = (
          await deps.instances.createInstance({
            name: target.name,
            kind: target.kind,
            values,
            caller: c,
          })
        ).id
      }
      if (target.enabled !== (existing?.enabled !== false)) {
        await deps.instances.setInstanceEnabled({ id, enabled: target.enabled, caller: c })
      }
      const saved = await deps.instances.getInstance({ id, caller: c })
      if (saved === null) throw forbiddenError(`target not owned: ${id}`)
      return { target: asTarget(saved) }
    },

    'nc.deleteMyTarget': async (input, caller) => {
      const c = requireCaller(caller)
      await requireOwn(input.targetId, c)
      await deps.instances.deleteInstance({ id: input.targetId, caller: c })
      return { success: true }
    },

    'nc.setMyTargetEnabled': async (input, caller) => {
      const c = requireCaller(caller)
      await requireOwn(input.targetId, c)
      await deps.instances.setInstanceEnabled({
        id: input.targetId,
        enabled: input.enabled,
        caller: c,
      })
      return { success: true }
    },

    'nc.testMyTarget': async (input, caller) => {
      const c = requireCaller(caller)
      await requireOwn(input.targetId, c)
      const result = await deps.instances.testInstance?.({
        id: input.targetId,
        values: {},
        caller: c,
      })
      if (result === undefined) return { success: false, error: 'This kind cannot be tested' }
      return { success: result.success, ...(result.error !== undefined ? { error: result.error } : {}) }
    },
  }
}
