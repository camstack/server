import { z } from 'zod'
import { ActionEntrySchema, ActionVariableValueSchema } from '../automation/action.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * action-source — an addon DECLARES runnable actions (a Home Assistant script,
 * a scene, a vendor routine) as list entries. Never as devices.
 *
 * It mirrors `notification-output`: `listActions` returns an array, so the
 * generated cap mount concat-fans it across every provider; `runAction` and
 * `stopAction` route to ONE provider by the `addonId` the generated collection
 * router extracts from the call input.
 *
 * Nobody but the `actions` surface (the core-blocks builtin) calls this cap.
 * The UI and automations talk to `actions`, which fans out here LIVE on every
 * `list` and keeps no catalog of its own (D3: no shadow registry).
 *
 * `listActions` entries carry `source: 'addon'`, `readOnly: true`, an id of
 * `<addonId>:<localId>` and an idle `status` (the provider may fill what it
 * knows). `actionId` on `runAction` / `stopAction` is the full entry id.
 */
export const actionSourceCapability = {
  name: 'action-source',
  scope: 'system',
  mode: 'collection',
  // Every method is admin: the tier gates sessions and tokens, never addons
  // (an addon's `ctx.api` call is resolved to the provider directly). A viewer
  // reaches an action only through `actions`, which checks the camera link.
  methods: {
    listActions: method(z.object({}), z.array(ActionEntrySchema), { auth: 'admin' }),
    runAction: method(
      z.object({
        actionId: z.string().min(1),
        variables: z.record(z.string(), ActionVariableValueSchema).optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    stopAction: method(z.object({ actionId: z.string().min(1) }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IActionSourceProvider = InferProvider<typeof actionSourceCapability>
