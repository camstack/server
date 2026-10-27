import { z } from 'zod'
import {
  ActionEntrySchema,
  ActionInputSchema,
  ActionRunChangedSchema,
  ActionRunOriginSchema,
  ActionRunResultSchema,
  ActionVariableValueSchema,
} from '../automation/action.js'
import { AutomationRunTraceSchema } from '../automation/trace.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * actions — the ONE surface for runnable actions, for the UI and for
 * automations. Provided by the core-blocks builtin on the hub.
 *
 * An action is a LIST ENTRY, not a device (D883): either internal (cap and wait
 * steps, kept in the hub's `actions` record kind) or declared by an addon over
 * `action-source`. `list` asks every `action-source` provider LIVE and overlays
 * the run status from the hub's `runs` ledger; there is no catalog here to
 * drift (D3).
 *
 * **Permissions follow the camera, as linked devices do.** An action is linked
 * to cameras by the operator (`setLinks`, D356: nothing links itself). A
 * non-admin may `get` / `run` an action only through a camera they may see that
 * links it: they name the camera (`deviceId`, a top-level field so the scope
 * gate sees it) and the provider refuses an action that camera does not link.
 * An admin, and an in-process caller (an automation block), may run any action.
 * Every refusal is typed (`[not-linked] …`) and logged.
 *
 * A second `run` of an action that is already running is REFUSED — traced and
 * logged — never queued.
 */

const ActionIdInput = z.object({ actionId: z.string().min(1) })

export const ActionLinksSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  actionIds: z.array(z.string().min(1)).max(100),
})
export type ActionLinks = z.infer<typeof ActionLinksSchema>

export const actionsCapability = {
  name: 'actions',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** Every action, live from the providers, with its run status. Admin. */
    list: method(z.object({}), z.array(ActionEntrySchema), { auth: 'admin' }),
    /**
     * One action. A non-admin names the camera (`deviceId`) that links it.
     * `null` when it does not exist.
     */
    get: method(
      z.object({
        actionId: z.string().min(1),
        deviceId: z.number().int().nonnegative().optional(),
      }),
      z.object({ action: ActionEntrySchema.nullable() }),
      { role: 'viewer', auth: 'protected', kind: 'query', caller: 'required' },
    ),
    /**
     * Start an action. `wait` holds the call until the run ended (an automation
     * step does); without it the call returns `started`. A non-admin names the
     * camera (`deviceId`) that links the action.
     */
    run: method(
      z.object({
        actionId: z.string().min(1),
        variables: z.record(z.string(), ActionVariableValueSchema).optional(),
        wait: z.boolean().optional(),
        origin: ActionRunOriginSchema.optional(),
        deviceId: z.number().int().nonnegative().optional(),
      }),
      ActionRunResultSchema,
      { role: 'viewer', auth: 'protected', kind: 'mutation', caller: 'required' },
    ),
    stop: method(ActionIdInput, z.void(), { kind: 'mutation', auth: 'admin' }),
    getTraces: method(ActionIdInput, z.object({ traces: z.array(AutomationRunTraceSchema) }), {
      auth: 'admin',
    }),
    /** Internal actions only. A read-only (addon) entry is refused with `[read-only]`. */
    create: method(
      z.object({ action: ActionInputSchema }),
      z.object({ action: ActionEntrySchema }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    update: method(
      z.object({ actionId: z.string().min(1), action: ActionInputSchema.partial() }),
      z.object({ action: ActionEntrySchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    delete: method(ActionIdInput, z.void(), { kind: 'mutation', auth: 'admin' }),
    /**
     * What a viewer sees under a camera: the actions this camera LINKS, with
     * their variables, and only when the caller may see the camera. The scope
     * gate admits the camera; the answer is cut to the linked ones.
     */
    listForCamera: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.array(ActionEntrySchema),
      { role: 'viewer', auth: 'protected', kind: 'query' },
    ),
    /** The actions a camera links. Admin (the picker). */
    getLinks: method(z.object({ deviceId: z.number().int().nonnegative() }), ActionLinksSchema, {
      auth: 'admin',
    }),
    /** Replace a camera's linked actions with what the operator picked. */
    setLinks: method(ActionLinksSchema, ActionLinksSchema, { kind: 'mutation', auth: 'admin' }),
  },
  events: {
    /** A run started or ended. Telemetry (D8): `list` is the authority. */
    onRunChanged: { data: ActionRunChangedSchema },
  },
} as const satisfies CapabilityDefinition

export type IActionsProvider = InferProvider<typeof actionsCapability>
